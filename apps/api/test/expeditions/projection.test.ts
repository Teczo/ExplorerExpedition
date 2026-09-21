/**
 * The flat copy of a revision (EXPD-017).
 *
 * Migration 0001 says the mission and node tables are "a flat copy of the
 * parts other rows have to point at, written from this document by EXPD-017
 * whenever the revision is saved". This is that promise, tested.
 *
 * The copy exists because a foreign key cannot point inside a JSON document.
 * A mission attempt (EXPD-020) points at a `mission_instance` row; a team's
 * progress (EXPD-013) is recorded against a `mission_node` row. So what is
 * checked here is that those rows are there, that they carry the document's
 * own keys so the two can be joined back up, and — the part that matters most
 * — that they are rewritten rather than added to when the document changes.
 */

import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';

import type { FakeRow } from '../support/fake-database.ts';
import {
  as,
  createExpedition,
  documentFor,
  harness,
  token,
  unfinishedDocument,
  ORG_A,
  type Harness,
} from './support.ts';

let api: Harness;

before(async () => {
  api = await harness();
});

after(async () => {
  await api.close();
});

/** The rows of one table that belong to one revision. */
function rowsFor(api: Harness, table: string, versionId: string): readonly FakeRow[] {
  return api.db
    .rowsIn(table)
    .filter((row) => row['expedition_version_id'] === versionId);
}

/** The id of the revision an answer is about. */
function versionId(body: Record<string, unknown>): string {
  return String((body['version'] as Record<string, unknown>)['id']);
}

describe('a saved draft that validates', () => {
  test('is copied out into missions, stops and hints', async () => {
    const { answer } = await createExpedition(api);
    const version = versionId(answer.body);

    const missions = rowsFor(api, 'mission_instance', version);
    assert.equal(missions.length, 1);
    assert.equal(missions[0]?.['instance_key'], 'alpha');
    assert.equal(missions[0]?.['mission_type_key'], 'code-match');
    assert.equal(missions[0]?.['mission_type_version'], '1.0.0');
    assert.equal(missions[0]?.['organisation_id'], ORG_A);
    // No such type is registered in this test, and a draft is allowed to name
    // one nobody has registered yet (0001 leaves the column nullable).
    assert.equal(missions[0]?.['mission_type_id'], null);

    const nodes = rowsFor(api, 'mission_node', version);
    assert.deepEqual(
      nodes.map((row) => row['node_key']).sort(),
      ['finish', 'node-alpha', 'start'],
    );

    const hints = api.db
      .rowsIn('hint')
      .filter((row) => row['mission_instance_id'] === missions[0]?.['id']);
    assert.equal(hints.length, 1);
    assert.equal(hints[0]?.['hint_key'], 'hint-1');
    assert.equal(hints[0]?.['token_cost'], 1);
  });

  test('puts the mission stop’s row id on the stop, not the document’s key', async () => {
    const { answer } = await createExpedition(api);
    const version = versionId(answer.body);

    const mission = rowsFor(api, 'mission_instance', version)[0];
    const stop = rowsFor(api, 'mission_node', version).find(
      (row) => row['node_key'] === 'node-alpha',
    );

    assert.equal(stop?.['mission_instance_id'], mission?.['id']);
    assert.equal(stop?.['kind'], 'mission');
  });

  test('copies the edges that leave each stop, and none onto a finish', async () => {
    const { answer } = await createExpedition(api);
    const version = versionId(answer.body);
    const nodes = rowsFor(api, 'mission_node', version);

    const start = nodes.find((row) => row['node_key'] === 'start');
    assert.deepEqual(start?.['outgoing_edges'], [
      { id: 'e1', from: 'start', to: 'node-alpha' },
    ]);

    const finish = nodes.find((row) => row['node_key'] === 'finish');
    assert.deepEqual(finish?.['outgoing_edges'], []);
  });
});

describe('when the document changes', () => {
  test('the copy is rewritten, not added to', async () => {
    const own = await harness();
    try {
      const { id, answer } = await createExpedition(own);
      const version = versionId(answer.body);

      const renamed = documentFor();
      const missions = renamed['missions'] as Record<string, unknown>[];
      (missions[0] as Record<string, unknown>)['title'] = 'Find the other code';

      await own.request(
        `/expeditions/${id}/draft`,
        as(token(ORG_A), { method: 'PUT', body: { definition: renamed } }),
      );

      const after = rowsFor(own, 'mission_instance', version);
      assert.equal(after.length, 1, 'the old mission row should have gone');
      assert.equal(after[0]?.['title'], 'Find the other code');
      assert.equal(own.db.rowsIn('hint').length, 1, 'the old hint should have gone');
      assert.equal(rowsFor(own, 'mission_node', version).length, 3);
    } finally {
      await own.close();
    }
  });

  test('a draft that does not validate keeps no copy at all', async () => {
    const own = await harness();
    try {
      const { id, answer } = await createExpedition(own);
      const version = versionId(answer.body);
      assert.equal(rowsFor(own, 'mission_instance', version).length, 1);

      // Saving an unfinished document over a good one: a stale copy would
      // leave something else pointing at a mission the author has removed.
      await own.request(
        `/expeditions/${id}/draft`,
        as(token(ORG_A), { method: 'PUT', body: { definition: unfinishedDocument() } }),
      );

      assert.equal(rowsFor(own, 'mission_instance', version).length, 0);
      assert.equal(rowsFor(own, 'mission_node', version).length, 0);
      assert.equal(own.db.rowsIn('hint').length, 0);
    } finally {
      await own.close();
    }
  });

  test('publishing writes the copy for the revision it froze', async () => {
    const own = await harness();
    try {
      const { id } = await createExpedition(own);
      const published = await own.request(
        `/expeditions/${id}/publish`,
        as(token(ORG_A), { method: 'POST' }),
      );

      const version = versionId(published.body);
      assert.equal(rowsFor(own, 'mission_instance', version).length, 1);
      assert.equal(rowsFor(own, 'mission_node', version).length, 3);
    } finally {
      await own.close();
    }
  });

  test('a new revision gets its own copy, and the frozen one keeps its', async () => {
    const own = await harness();
    try {
      const { id, answer } = await createExpedition(own);
      const first = versionId(answer.body);
      await own.request(
        `/expeditions/${id}/publish`,
        as(token(ORG_A), { method: 'POST' }),
      );

      const saved = await own.request(
        `/expeditions/${id}/draft`,
        as(token(ORG_A), { method: 'PUT', body: { definition: documentFor() } }),
      );
      const second = versionId(saved.body);

      assert.notEqual(first, second);
      assert.equal(rowsFor(own, 'mission_instance', first).length, 1);
      assert.equal(rowsFor(own, 'mission_instance', second).length, 1);
    } finally {
      await own.close();
    }
  });
});

describe('the mission type registry', () => {
  test('is resolved to a row when one is registered, platform-wide included', async () => {
    const own = await harness();
    try {
      own.db.seed('mission_type', {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        organisation_id: null,
        type_key: 'code-match',
        version: '1.0.0',
      });

      const { answer } = await createExpedition(own);
      const missions = rowsFor(own, 'mission_instance', versionId(answer.body));

      assert.equal(
        missions[0]?.['mission_type_id'],
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      );
    } finally {
      await own.close();
    }
  });

  test('is never read across the tenant boundary', async () => {
    const own = await harness();
    try {
      // Riverbank Academy's own type, under the key Portside's document names.
      own.db.seed('mission_type', {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        organisation_id: '22222222-2222-4222-8222-222222222222',
        type_key: 'code-match',
        version: '1.0.0',
      });

      const { answer } = await createExpedition(own);
      const missions = rowsFor(own, 'mission_instance', versionId(answer.body));

      assert.equal(missions[0]?.['mission_type_id'], null);
    } finally {
      await own.close();
    }
  });
});

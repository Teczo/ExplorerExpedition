/**
 * Who may touch an expedition, and whose (EXPD-017).
 *
 * Two separate checks run on every request here, and they refuse different
 * things. Isolation (EXPD-004) decides whether the row is yours at all;
 * permissions decide whether somebody in your organisation may do this to it.
 * A facilitator reading their own school's expedition passes the first and
 * fails the second when they try to publish it.
 *
 * The refusals are told apart on purpose. Another organisation's expedition
 * is 404, not 403: an answer that said "you may not touch that" would be
 * telling Riverbank Academy that Portside School has an expedition with that
 * id. One of your own that you lack the permission for is 403, because you
 * already knew it was there.
 */

import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';

import { signAccessToken } from '../../src/auth/tokens.ts';
import { DEFAULT_LIFETIMES } from '../../src/config/auth-config.ts';
import type { FakeRow } from '../support/fake-database.ts';
import {
  as,
  createExpedition,
  documentFor,
  harness,
  token,
  AUTHOR,
  CONFIG,
  ORG_A,
  ORG_B,
  OTHER_AUTHOR,
  type Harness,
} from './support.ts';

let api: Harness;

before(async () => {
  api = await harness();
});

after(async () => {
  await api.close();
});

/** A student's phone, which holds none of these permissions. */
function deviceToken(): string {
  return signAccessToken(
    CONFIG.signingKey,
    {
      sub: '66666666-6666-4666-8666-666666666666',
      aud: 'device',
      org: ORG_A,
      ses: '77777777-7777-4777-8777-777777777777',
      dev: '88888888-8888-4888-8888-888888888888',
    },
    DEFAULT_LIFETIMES.accessSeconds,
  );
}

/** Every audit entry the fake database holds, oldest first. */
function entries(api: Harness): readonly FakeRow[] {
  return api.db.rowsIn('audit_log');
}

describe('another organisation’s expedition', () => {
  test('is not found, rather than refused', async () => {
    const { id } = await createExpedition(api);

    const answer = await api.request(`/expeditions/${id}`, as(token(ORG_B)));

    assert.equal(answer.status, 404);
    assert.equal(answer.body['error'], 'not-found');
  });

  test('cannot be saved over, and is left as it was', async () => {
    const { id } = await createExpedition(api);
    const stolen = documentFor();
    (stolen['metadata'] as Record<string, unknown>)['title'] = 'Ours now';

    const answer = await api.request(
      `/expeditions/${id}/draft`,
      as(token(ORG_B), { method: 'PUT', body: { definition: stolen } }),
    );

    assert.equal(answer.status, 404);

    const mine = await api.request(`/expeditions/${id}/draft`, as(token(ORG_A)));
    assert.equal(
      (mine.body['version'] as Record<string, unknown>)['title'],
      'A walk round the museum',
    );
  });

  test('cannot be published', async () => {
    const { id } = await createExpedition(api);

    const answer = await api.request(
      `/expeditions/${id}/publish`,
      as(token(ORG_B), { method: 'POST' }),
    );

    assert.equal(answer.status, 404);
  });

  test('is not in their list', async () => {
    const own = await harness();
    try {
      await createExpedition(own);

      const theirs = await own.request('/expeditions', as(token(ORG_B)));

      assert.equal(theirs.body['total'], 0);
      assert.deepEqual(theirs.body['expeditions'], []);
    } finally {
      await own.close();
    }
  });
});

describe('what a role may do', () => {
  test('a facilitator may read', async () => {
    const { id } = await createExpedition(api);

    const answer = await api.request(
      `/expeditions/${id}`,
      as(token(ORG_A, { role: 'facilitator' })),
    );

    assert.equal(answer.status, 200);
  });

  test('a facilitator may not save', async () => {
    const { id } = await createExpedition(api);

    const answer = await api.request(
      `/expeditions/${id}/draft`,
      as(token(ORG_A, { role: 'facilitator' }), {
        method: 'PUT',
        body: { definition: documentFor() },
      }),
    );

    assert.equal(answer.status, 403);
    assert.equal(answer.body['error'], 'forbidden');
  });

  test('a facilitator may not publish', async () => {
    const { id } = await createExpedition(api);

    const answer = await api.request(
      `/expeditions/${id}/publish`,
      as(token(ORG_A, { role: 'facilitator' }), { method: 'POST' }),
    );

    assert.equal(answer.status, 403);
  });

  test('a student’s phone is refused outright', async () => {
    const answer = await api.request('/expeditions', as(deviceToken()));

    assert.equal(answer.status, 403);
  });

  test('no token at all is 401, and says what was wanted', async () => {
    const answer = await api.request('/expeditions');

    assert.equal(answer.status, 401);
    assert.equal(answer.headers.get('www-authenticate'), 'Bearer');
  });
});

describe('the audit log', () => {
  test('records creating, changing and publishing, and who did each', async () => {
    const own = await harness();
    try {
      const { id } = await createExpedition(own);
      await own.request(
        `/expeditions/${id}/draft`,
        as(token(ORG_A, { userId: OTHER_AUTHOR }), {
          method: 'PUT',
          body: { definition: documentFor() },
        }),
      );
      await own.request(
        `/expeditions/${id}/publish`,
        as(token(ORG_A), { method: 'POST' }),
      );

      const actions = entries(own).map((row) => row['action']);
      assert.deepEqual(actions, [
        'expedition.created',
        'expedition.updated',
        'expedition.published',
      ]);

      // Every entry belongs to the organisation the token named, and names
      // the account that really called rather than anything in the body.
      assert.ok(entries(own).every((row) => row['organisation_id'] === ORG_A));
      assert.equal(entries(own)[0]?.['actor_user_id'], AUTHOR);
      assert.equal(entries(own)[1]?.['actor_user_id'], OTHER_AUTHOR);

      // `expedition.published` is about the revision, not the expedition, so
      // the entity it points at is the revision's id (EXPD-006).
      assert.equal(entries(own)[0]?.['entity_type'], 'expedition');
      assert.equal(entries(own)[2]?.['entity_type'], 'expedition_version');
    } finally {
      await own.close();
    }
  });

  test('writes no entry for a publish that was refused', async () => {
    const own = await harness();
    try {
      const { id } = await createExpedition(own);
      own.db.forgetStatements();

      const refused = await own.request(
        `/expeditions/${id}/publish`,
        as(token(ORG_A, { role: 'facilitator' }), { method: 'POST' }),
      );

      assert.equal(refused.status, 403);
      assert.deepEqual(
        entries(own).map((row) => row['action']),
        ['expedition.created'],
      );
    } finally {
      await own.close();
    }
  });
});

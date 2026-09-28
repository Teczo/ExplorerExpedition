/**
 * Publishing a mission type, and starting its next version (EXPD-031).
 *
 * Over HTTP against the whole app, the same as the builder's tests.
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { as, harness, token, ORG_A, ORG_B, type Harness } from '../expeditions/support.ts';

let api: Harness;

before(async () => {
  api = await harness();
});

after(async () => {
  await api.close();
});

/** A type with nothing wrong with it. */
function missionType(key: string, version = '1.0.0'): Record<string, unknown> {
  return {
    key,
    version,
    name: 'Leaf rubbing',
    description: 'Teams make a rubbing of a leaf.',
    capabilities: ['camera'],
    configSchema: {
      type: 'object',
      properties: { tree: { type: 'string', minLength: 1 } },
      required: ['tree'],
    },
    submissionSchema: {
      type: 'object',
      properties: { note: { type: 'string' } },
    },
    defaultConfig: { tree: 'Oak' },
    validationMethod: 'teacher',
    defaultScoring: { basePoints: 5, allowPartialCredit: false },
    studentLayout: {
      blocks: [{ kind: 'brief' }, { kind: 'config-field', field: 'tree' }, { kind: 'submission' }],
      submitLabel: 'Send',
    },
  };
}

/** A stored row, for cases the builder cannot make. */
function row(id: string, key: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    organisation_id: ORG_A,
    type_key: key,
    version: '1.0.0',
    name: key,
    description: '',
    status: 'draft',
    capabilities: [],
    config_schema: {},
    submission_schema: {},
    default_config: {},
    validation_method: 'teacher',
    default_scoring: { basePoints: 0, allowPartialCredit: false },
    student_layout: { blocks: [{ kind: 'submission' }], submitLabel: 'Submit' },
    ...over,
  };
}

async function create(key: string, bearer = token(ORG_A)): Promise<string> {
  const answer = await api.request(
    '/mission-types',
    as(bearer, { method: 'POST', body: { missionType: missionType(key) } }),
  );
  assert.equal(answer.status, 201);
  return String(answer.body['id']);
}

async function publish(id: string, bearer = token(ORG_A)) {
  return api.request(`/mission-types/${id}/publish`, as(bearer, { method: 'POST' }));
}

async function newVersion(id: string, version: string, bearer = token(ORG_A)) {
  return api.request(
    `/mission-types/${id}/versions`,
    as(bearer, { method: 'POST', body: { version } }),
  );
}

describe('publishing one', () => {
  test('freezes a draft, and it can no longer be saved over', async () => {
    const id = await create('leaf-rubbing');
    const answer = await publish(id);

    assert.equal(answer.status, 200);
    assert.equal(answer.body['status'], 'published');
    assert.equal(answer.body['editable'], false);

    const saved = await api.request(
      `/mission-types/${id}`,
      as(token(ORG_A), { method: 'PUT', body: { missionType: missionType('leaf-rubbing') } }),
    );
    assert.equal(saved.status, 409);
  });

  test('writes an audit entry, saying what it was before', async () => {
    const id = await create('audited-rubbing');
    await publish(id);
    const entry = api.db
      .rowsIn('audit_log')
      .find((stored) => stored['entity_id'] === id && stored['action'] === 'mission-type.published');
    assert.ok(entry !== undefined);
    assert.equal(entry['organisation_id'], ORG_A);
    const changes = entry['changes'] as { before: { status: string }; after: { status: string } };
    assert.deepEqual(changes.before, { status: 'draft' });
    assert.deepEqual(changes.after, { status: 'published' });
  });

  test('a second publish is a conflict', async () => {
    const id = await create('twice-rubbing');
    await publish(id);
    assert.equal((await publish(id)).status, 409);
  });

  test('refuses a draft that does not pass, and says where each problem is', async () => {
    const id = '11111111-2222-4333-8444-555555555555';
    // A layout with no hand-in area, which the builder would refuse.
    api.db.seed('mission_type', row(id, 'broken-rubbing', {
      student_layout: { blocks: [{ kind: 'brief' }], submitLabel: 'Submit' },
    }));

    const answer = await publish(id);
    assert.equal(answer.status, 422);
    const paths = (answer.body['details'] as { path: string }[]).map((issue) => issue.path);
    assert.deepEqual(paths, ['studentLayout.blocks']);
  });

  test('does not publish a platform type', async () => {
    const id = '11111111-2222-4333-8444-666666666666';
    api.db.seed('mission_type', row(id, 'platform-rubbing', { organisation_id: null }));
    assert.equal((await publish(id)).status, 409);
  });

  test('another organisation’s type is not found', async () => {
    const theirs = await create('their-rubbing', token(ORG_B));
    assert.equal((await publish(theirs)).status, 404);
  });

  test('is refused to a facilitator, who may only read', async () => {
    const id = await create('facilitated-rubbing');
    assert.equal((await publish(id, token(ORG_A, { role: 'facilitator' }))).status, 403);
  });
});

describe('starting the next version', () => {
  test('copies a published type into a new draft under the same key', async () => {
    const id = await create('versioned-rubbing');
    await publish(id);

    const answer = await newVersion(id, '1.1.0');
    assert.equal(answer.status, 201);
    assert.equal(answer.headers.get('location'), `/mission-types/${String(answer.body['id'])}`);
    assert.notEqual(answer.body['id'], id);
    assert.equal(answer.body['key'], 'versioned-rubbing');
    assert.equal(answer.body['version'], '1.1.0');
    assert.equal(answer.body['status'], 'draft');
    assert.equal(answer.body['editable'], true);
    assert.deepEqual(answer.body['defaultConfig'], { tree: 'Oak' });
    assert.equal((answer.body['studentLayout'] as { submitLabel: string }).submitLabel, 'Send');

    const old = await api.request(`/mission-types/${id}`, as(token(ORG_A)));
    assert.equal(old.body['status'], 'published');
    assert.equal(old.body['version'], '1.0.0');

    const entry = api.db
      .rowsIn('audit_log')
      .find((stored) => stored['entity_id'] === answer.body['id']);
    assert.equal(entry?.['action'], 'mission-type.created');
    const changes = entry?.['changes'] as { after: { copied_from: string } };
    assert.equal(changes.after.copied_from, '1.0.0');
  });

  test('the new draft can be changed and published in its turn', async () => {
    const id = await create('second-rubbing');
    await publish(id);
    const next = await newVersion(id, '2.0.0');

    const changed = await api.request(
      `/mission-types/${String(next.body['id'])}`,
      as(token(ORG_A), {
        method: 'PUT',
        body: { missionType: { ...missionType('second-rubbing', '2.0.0'), name: 'Bark rubbing' } },
      }),
    );
    assert.equal(changed.status, 200);
    assert.equal(changed.body['name'], 'Bark rubbing');
    assert.equal((await publish(String(next.body['id']))).status, 200);
  });

  test('has to be higher than every version of the key', async () => {
    const id = await create('lower-rubbing');
    await publish(id);
    assert.equal((await newVersion(id, '1.0.0')).status, 409);
    assert.equal((await newVersion(id, '0.9.0')).status, 409);
  });

  test('allows one draft of a key at a time', async () => {
    const id = await create('busy-rubbing');
    await publish(id);
    assert.equal((await newVersion(id, '1.1.0')).status, 201);
    const answer = await newVersion(id, '1.2.0');
    assert.equal(answer.status, 409);
    assert.match(String(answer.body['message']), /1\.1\.0 is already a draft/);
  });

  test('is not offered for a draft, which is changed instead', async () => {
    const id = await create('still-draft-rubbing');
    assert.equal((await newVersion(id, '1.1.0')).status, 409);
  });

  test('refuses something that is not a version', async () => {
    const id = await create('shaped-rubbing');
    await publish(id);
    const answer = await newVersion(id, '1.1');
    assert.equal(answer.status, 422);
    const paths = (answer.body['details'] as { path: string }[]).map((issue) => issue.path);
    assert.deepEqual(paths, ['version']);
  });

  test('does not version a platform type', async () => {
    const id = '11111111-2222-4333-8444-777777777777';
    api.db.seed('mission_type', row(id, 'platform-versioned', {
      organisation_id: null,
      status: 'published',
    }));
    assert.equal((await newVersion(id, '1.1.0')).status, 409);
  });

  test('another organisation’s type is not found', async () => {
    const theirs = await create('their-versioned', token(ORG_B));
    await publish(theirs, token(ORG_B));
    assert.equal((await newVersion(theirs, '1.1.0')).status, 404);
  });
});

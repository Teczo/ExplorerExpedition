/**
 * Saving a mission type from the Studio's builder (EXPD-025).
 *
 * Over HTTP against the whole app, the same as the expedition tests, because
 * most of what is promised is about the stack in front of the handler: a
 * facilitator cannot save one, another organisation's is not found, and the
 * audit entry names whoever really called.
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

/** A type with nothing wrong with it. `key` differs per test, so they do not collide. */
function missionType(key: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key,
    version: '1.0.0',
    name: 'Bird count',
    description: 'Teams count the birds they see.',
    capabilities: ['location'],
    configSchema: {
      type: 'object',
      properties: { species: { type: 'string', minLength: 1 } },
      required: ['species'],
    },
    submissionSchema: {
      type: 'object',
      properties: { count: { type: 'integer', minimum: 0 } },
      required: ['count'],
    },
    defaultConfig: { species: 'Robin' },
    validationMethod: 'teacher',
    defaultScoring: { basePoints: 10, allowPartialCredit: false },
    studentLayout: {
      blocks: [{ kind: 'brief' }, { kind: 'config-field', field: 'species' }, { kind: 'submission' }],
      submitLabel: 'Send count',
    },
    ...over,
  };
}

/** A row the platform owns: no organisation, readable by every one. */
function platformRow(id: string, key: string, status: string): Record<string, unknown> {
  return {
    id,
    organisation_id: null,
    type_key: key,
    version: '1.0.0',
    name: key,
    description: '',
    status,
    capabilities: [],
    config_schema: {},
    submission_schema: {},
    default_config: {},
    validation_method: 'teacher',
    default_scoring: { basePoints: 0, allowPartialCredit: false },
    student_layout: { blocks: [{ kind: 'submission' }], submitLabel: 'Submit' },
  };
}

async function create(key: string, bearer = token(ORG_A), over: Record<string, unknown> = {}) {
  return api.request(
    '/mission-types',
    as(bearer, { method: 'POST', body: { missionType: missionType(key, over) } }),
  );
}

describe('creating one', () => {
  test('answers 201 with a draft of this organisation, and says where it went', async () => {
    const answer = await create('bird-count');

    assert.equal(answer.status, 201);
    assert.equal(answer.headers.get('location'), `/mission-types/${String(answer.body['id'])}`);
    assert.equal(answer.body['status'], 'draft');
    assert.equal(answer.body['owner'], 'organisation');
    assert.equal(answer.body['editable'], true);
    assert.equal(answer.body['validationMethod'], 'teacher');
    assert.deepEqual(answer.body['defaultScoring'], { basePoints: 10, allowPartialCredit: false });
    assert.equal(
      (answer.body['studentLayout'] as { submitLabel: string }).submitLabel,
      'Send count',
    );

    const row = api.db.rowsIn('mission_type').find((stored) => stored['id'] === answer.body['id']);
    assert.equal(row?.['organisation_id'], ORG_A);
    assert.equal(row?.['status'], 'draft');
  });

  test('writes an audit entry naming the caller', async () => {
    const answer = await create('audited-count');
    const entry = api.db
      .rowsIn('audit_log')
      .find((stored) => stored['entity_id'] === answer.body['id']);
    assert.equal(entry?.['action'], 'mission-type.created');
    assert.equal(entry?.['organisation_id'], ORG_A);
  });

  test('refuses a type that does not pass, and says where each problem is', async () => {
    const answer = await create('broken-count', token(ORG_A), {
      defaultScoring: { basePoints: -1, allowPartialCredit: false },
      studentLayout: { blocks: [{ kind: 'brief' }], submitLabel: 'Go' },
    });

    assert.equal(answer.status, 422);
    const paths = (answer.body['details'] as { path: string }[]).map((issue) => issue.path);
    assert.deepEqual(paths, ['missionType.defaultScoring.basePoints', 'missionType.studentLayout.blocks']);
  });

  test('refuses defaults that fail the type’s own config schema', async () => {
    const answer = await create('empty-default', token(ORG_A), { defaultConfig: {} });
    assert.equal(answer.status, 422);
    const paths = (answer.body['details'] as { path: string }[]).map((issue) => issue.path);
    assert.deepEqual(paths, ['missionType.defaultConfig.species']);
  });

  test('refuses a field a mission type does not have', async () => {
    const answer = await create('extra-field', token(ORG_A), { colour: 'blue' });
    assert.equal(answer.status, 422);
    const paths = (answer.body['details'] as { path: string }[]).map((issue) => issue.path);
    assert.deepEqual(paths, ['missionType.colour']);
  });

  test('saves only drafts', async () => {
    const answer = await create('published-count', token(ORG_A), { status: 'published' });
    assert.equal(answer.status, 422);
  });

  test('refuses a key and version this organisation already holds', async () => {
    await create('twice-count');
    const answer = await create('twice-count');
    assert.equal(answer.status, 409);
  });

  test('refuses a key and version the platform already holds', async () => {
    api.db.seed('mission_type', platformRow('99999999-9999-4999-8999-999999999999', 'qr-hunt', 'published'));
    const answer = await create('qr-hunt');
    assert.equal(answer.status, 409);
  });

  test('may use a key another organisation holds', async () => {
    await create('shared-name', token(ORG_B));
    const answer = await create('shared-name');
    assert.equal(answer.status, 201);
  });

  test('is refused to a facilitator, who may only read', async () => {
    const answer = await create('facilitated', token(ORG_A, { role: 'facilitator' }));
    assert.equal(answer.status, 403);
  });
});

describe('reading them', () => {
  test('lists this organisation’s own and the platform’s, and nobody else’s', async () => {
    api.db.seed('mission_type', platformRow('77777777-7777-4777-8777-777777777777', 'puzzle', 'published'));
    await create('mine-count');
    await create('theirs-count', token(ORG_B));

    const answer = await api.request('/mission-types', as(token(ORG_A)));
    assert.equal(answer.status, 200);
    const keys = (answer.body['missionTypes'] as { key: string; owner: string }[]).map(
      (type) => `${type.key}:${type.owner}`,
    );
    assert.ok(keys.includes('mine-count:organisation'));
    assert.ok(keys.includes('puzzle:platform'));
    assert.ok(!keys.some((key) => key.startsWith('theirs-count')));
  });

  test('a facilitator may read', async () => {
    const answer = await api.request(
      '/mission-types',
      as(token(ORG_A, { role: 'facilitator' })),
    );
    assert.equal(answer.status, 200);
  });

  test('another organisation’s type is not found', async () => {
    const theirs = await create('hidden-count', token(ORG_B));
    const answer = await api.request(`/mission-types/${String(theirs.body['id'])}`, as(token(ORG_A)));
    assert.equal(answer.status, 404);
  });
});

describe('changing one', () => {
  async function save(id: unknown, body: Record<string, unknown>, bearer = token(ORG_A)) {
    return api.request(
      `/mission-types/${String(id)}`,
      as(bearer, { method: 'PUT', body: { missionType: body } }),
    );
  }

  test('saves over a draft, and records what it was before', async () => {
    const created = await create('changing-count');
    const answer = await save(
      created.body['id'],
      missionType('changing-count', {
        name: 'Bird tally',
        validationMethod: 'automatic-with-review',
        defaultScoring: { basePoints: 20, allowPartialCredit: true, maxPoints: 25 },
      }),
    );

    assert.equal(answer.status, 200);
    assert.equal(answer.body['name'], 'Bird tally');
    assert.equal(answer.body['validationMethod'], 'automatic-with-review');

    const entry = api.db
      .rowsIn('audit_log')
      .find(
        (stored) =>
          stored['entity_id'] === created.body['id'] && stored['action'] === 'mission-type.updated',
      );
    assert.ok(entry !== undefined);
  });

  test('keeps the key and version fixed', async () => {
    const created = await create('fixed-count');
    const answer = await save(created.body['id'], missionType('renamed-count'));
    assert.equal(answer.status, 409);
  });

  test('does not change a type that is no longer a draft', async () => {
    const id = '66666666-6666-4666-8666-666666666666';
    api.db.seed('mission_type', {
      ...platformRow(id, 'frozen-count', 'published'),
      organisation_id: ORG_A,
    });

    const answer = await save(id, missionType('frozen-count'));
    assert.equal(answer.status, 409);
  });

  test('does not change a platform type', async () => {
    api.db.seed('mission_type', platformRow('88888888-8888-4888-8888-888888888888', 'photo-evidence', 'draft'));
    const answer = await save('88888888-8888-4888-8888-888888888888', missionType('photo-evidence'));
    assert.equal(answer.status, 409);
  });

  test('another organisation’s type is not found', async () => {
    const theirs = await create('guarded-count', token(ORG_B));
    const answer = await save(theirs.body['id'], missionType('guarded-count'));
    assert.equal(answer.status, 404);
  });
});

/**
 * Publishing a mission type, and its next version, as the builder offers
 * them (EXPD-031).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { missionTypeApi, type MissionTypeView } from '../src/mission-types/api.ts';
import { lifecycleOf, versionsOf } from '../src/mission-types/lifecycle.ts';

const clean = { issues: 0, unsaved: false };

function view(over: Partial<MissionTypeView> = {}): MissionTypeView {
  return {
    id: 'type-1',
    key: 'bird-count',
    version: '1.0.0',
    name: 'Bird count',
    description: '',
    status: 'draft',
    capabilities: [],
    configSchema: { type: 'object', properties: {} },
    submissionSchema: {
      type: 'object',
      properties: { answer: { type: 'string', title: 'Answer' } },
    },
    defaultConfig: {},
    validationMethod: 'teacher',
    defaultScoring: { basePoints: 10, allowPartialCredit: false },
    studentLayout: { blocks: [{ kind: 'brief' }, { kind: 'submission' }], submitLabel: 'Submit' },
    owner: 'organisation',
    editable: true,
    createdBy: null,
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    ...over,
  };
}

describe('a draft', () => {
  test('may be published once it is saved and has no problems', () => {
    const saved = view();
    const lifecycle = lifecycleOf(saved, clean, [saved]);
    assert.deepEqual(lifecycle, { kind: 'draft', publishable: true, reason: null });
  });

  test('is not published with changes that are not saved', () => {
    const saved = view();
    const lifecycle = lifecycleOf(saved, { issues: 0, unsaved: true }, [saved]);
    assert.equal(lifecycle.kind === 'draft' && lifecycle.publishable, false);
  });

  test('is not published with problems', () => {
    const saved = view();
    const lifecycle = lifecycleOf(saved, { issues: 1, unsaved: true }, [saved]);
    assert.equal(lifecycle.kind === 'draft' && lifecycle.reason, 'Fix the problems above first.');
  });
});

describe('a published type', () => {
  test('suggests the next minor version after the highest of its key', () => {
    const one = view({ status: 'published', editable: false });
    const two = view({ id: 'type-2', version: '1.3.0', status: 'published', editable: false });
    const other = view({ id: 'type-3', key: 'other', version: '9.0.0', status: 'published' });
    const lifecycle = lifecycleOf(one, clean, [one, two, other]);
    assert.deepEqual(lifecycle, { kind: 'published', openDraft: null, suggestedVersion: '1.4.0' });
  });

  test('points at the draft of its key, when there is one', () => {
    const one = view({ status: 'published', editable: false });
    const next = view({ id: 'type-2', version: '1.1.0' });
    const lifecycle = lifecycleOf(one, clean, [one, next]);
    assert.equal(lifecycle.kind === 'published' && lifecycle.openDraft?.id, 'type-2');
  });

  test('a platform type offers neither', () => {
    const platform = view({ owner: 'platform', status: 'published', editable: false });
    assert.deepEqual(lifecycleOf(platform, clean, [platform]), { kind: 'platform' });
  });
});

test('versions of a key are listed lowest first, as numbers', () => {
  const types = [
    view({ id: 'c', version: '1.10.0' }),
    view({ id: 'a', version: '1.2.0' }),
    view({ id: 'x', key: 'other' }),
    view({ id: 'b', version: '1.9.0' }),
  ];
  assert.deepEqual(versionsOf(types, 'bird-count').map((type) => type.version), ['1.2.0', '1.9.0', '1.10.0']);
});

test('publish and new version call the API as it expects', async () => {
  const calls: { path: string; init: RequestInit | undefined }[] = [];
  const api = missionTypeApi(async <T,>(path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return view() as T;
  });

  await api.publish('type 1');
  await api.newVersion('type-1', '1.1.0');

  assert.equal(calls[0]?.path, '/mission-types/type%201/publish');
  assert.equal(calls[0]?.init?.method, 'POST');
  assert.equal(calls[1]?.path, '/mission-types/type-1/versions');
  assert.equal(calls[1]?.init?.body, JSON.stringify({ version: '1.1.0' }));
});

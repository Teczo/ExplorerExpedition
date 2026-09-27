import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { AuthoredMissionType } from '@explorer/shared-types';

import { missionTypeApi } from '../src/mission-types/api.ts';
import { blankDraft, draftOf, switchMode, toAuthored, type BuilderDraft } from '../src/mission-types/draft.ts';
import { blankField, fieldsFromSchema, schemaFromFields, type FieldDraft } from '../src/mission-types/fields.ts';

function field(over: Partial<FieldDraft>): FieldDraft {
  return { ...blankField(), ...over };
}

describe('fields become a config schema', () => {
  test('each kind writes the schema the platform runs', () => {
    const result = schemaFromFields([
      field({ name: 'species', label: 'Species', kind: 'text', required: true, min: '1', max: '40', defaultValue: 'Robin' }),
      field({ name: 'count', kind: 'whole-number', min: '0' }),
      field({ name: 'weight', kind: 'number', max: '2.5' }),
      field({ name: 'outdoor', kind: 'yes-no', defaultValue: 'true' }),
      field({ name: 'level', kind: 'choice', options: ['easy', 'hard'], defaultValue: 'easy' }),
      field({ name: 'codes', kind: 'text-list', min: '1', defaultValue: 'A\n\nB' }),
    ]);

    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.schema, {
      type: 'object',
      additionalProperties: false,
      required: ['species'],
      properties: {
        species: { type: 'string', title: 'Species', minLength: 1, maxLength: 40, default: 'Robin' },
        count: { type: 'integer', minimum: 0 },
        weight: { type: 'number', maximum: 2.5 },
        outdoor: { type: 'boolean', default: true },
        level: { type: 'string', enum: ['easy', 'hard'], default: 'easy' },
        codes: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, default: ['A', 'B'] },
      },
    });
    assert.deepEqual(result.defaults, {
      species: 'Robin',
      outdoor: true,
      level: 'easy',
      codes: ['A', 'B'],
    });
  });

  test('says which input of which field is wrong', () => {
    const { problems } = schemaFromFields([
      field({ name: '2nd' }),
      field({ name: 'a', kind: 'whole-number', min: '1.5' }),
      field({ name: 'a' }),
      field({ name: 'b', kind: 'choice', options: [] }),
      field({ name: 'c', kind: 'number', min: '5', max: '1' }),
    ]);
    assert.deepEqual(
      problems.map((problem) => `${problem.index}.${problem.input}`),
      ['0.name', '1.min', '2.name', '3.options', '4.max'],
    );
  });
});

describe('a saved schema becomes fields again', () => {
  test('what the fields wrote reads back the same', () => {
    const fields = [
      field({ name: 'species', label: 'Species', help: 'Common name', kind: 'text', required: true, pattern: '[A-Za-z ]+' }),
      field({ name: 'level', kind: 'choice', options: ['easy', 'hard'] }),
      field({ name: 'codes', kind: 'text-list', max: '5', defaultValue: 'A\nB' }),
    ];
    const { schema } = schemaFromFields(fields);
    assert.deepEqual(fieldsFromSchema(schema), fields);
  });

  test('a schema fields cannot show is left as JSON', () => {
    assert.equal(fieldsFromSchema({}), null);
    assert.equal(fieldsFromSchema({ type: 'object', additionalProperties: true }), null);
    assert.equal(
      fieldsFromSchema({ type: 'object', properties: { nested: { type: 'object' } } }),
      null,
    );
    assert.equal(
      fieldsFromSchema({ type: 'object', properties: { n: { type: 'number', multipleOf: 2 } } }),
      null,
    );
  });
});

function filled(): BuilderDraft {
  return {
    ...blankDraft(),
    key: 'bird-count',
    name: 'Bird count',
    config: {
      mode: 'fields',
      fields: [field({ name: 'species', kind: 'text', required: true, defaultValue: 'Robin' })],
    },
    basePoints: '10',
  };
}

describe('the whole form', () => {
  test('a new form is not yet savable, and says why', () => {
    const paths = toAuthored(blankDraft()).issues.map((issue) => issue.path);
    assert.ok(paths.includes('key'));
    assert.ok(paths.includes('name'));
  });

  test('a filled form becomes a type the API will take', () => {
    const { type, issues } = toAuthored(filled());
    assert.deepEqual(issues, []);
    assert.equal(type.status, 'draft');
    assert.deepEqual(type.defaultConfig, { species: 'Robin' });
    assert.deepEqual(type.defaultScoring, { basePoints: 10, allowPartialCredit: false });
    assert.equal(type.validationMethod, 'teacher');
  });

  test('a required setting with no default is reported against the defaults', () => {
    const draft = filled();
    const { issues } = toAuthored({
      ...draft,
      config: { mode: 'fields', fields: [field({ name: 'species', required: true })] },
    });
    assert.deepEqual(issues.map((issue) => issue.path), ['defaultConfig.species']);
  });

  test('scoring typed wrong is named by the shared check', () => {
    const { issues } = toAuthored({ ...filled(), basePoints: 'ten', maxPoints: '5' });
    assert.deepEqual(issues.map((issue) => issue.path), ['defaultScoring.basePoints']);
  });

  test('a layout showing a setting that is not there is reported', () => {
    const { issues } = toAuthored({
      ...filled(),
      layout: { blocks: [{ kind: 'config-field', field: 'colour' }, { kind: 'submission' }], submitLabel: 'Go' },
    });
    assert.deepEqual(issues.map((issue) => issue.path), ['studentLayout.blocks[0].field']);
  });

  test('JSON that does not parse is reported, not sent', () => {
    const { issues } = toAuthored({ ...filled(), submission: { mode: 'json', text: '{ nope' } });
    assert.deepEqual(issues.map((issue) => issue.path), ['submissionSchema']);
  });

  test('a saved type opens as the form it was saved from', () => {
    const { type } = toAuthored(filled());
    const reopened = toAuthored(draftOf(type));
    assert.deepEqual(reopened.issues, []);
    assert.deepEqual(reopened.type, type);
  });

  test('switching to JSON and back keeps the fields', () => {
    const config = filled().config;
    const json = switchMode(config);
    assert.equal(json?.mode, 'json');
    assert.deepEqual(json === null ? null : switchMode(json), config);
  });
});

describe('the endpoints', () => {
  test('call the paths the API serves, with the body it reads', async () => {
    const seen: { path: string; init: RequestInit | undefined }[] = [];
    const api = missionTypeApi(async <T,>(path: string, init?: RequestInit) => {
      seen.push({ path, init });
      return (path === '/mission-types' && init === undefined ? { missionTypes: [] } : {}) as T;
    });
    const type = { key: 'x' } as unknown as AuthoredMissionType;

    assert.deepEqual(await api.list(), []);
    await api.create(type);
    await api.update('id-1', type);

    assert.deepEqual(
      seen.map((call) => `${call.init?.method ?? 'GET'} ${call.path}`),
      ['GET /mission-types', 'POST /mission-types', 'PUT /mission-types/id-1'],
    );
    assert.deepEqual(JSON.parse(String(seen[1]?.init?.body)), { missionType: { key: 'x' } });
  });
});

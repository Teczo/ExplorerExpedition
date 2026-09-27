/**
 * Checking a mission type the Studio built (EXPD-025).
 *
 * The builder saves a type only when this check passes, so these tests hold
 * the three things it adds to account: the validation method, the default
 * scoring and the student layout. The registry's own fields are
 * `definition.test.ts`'s, and are only checked here to show they still are.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_MISSION_TYPE_AUTHORING,
  MAX_LAYOUT_BLOCKS,
  MAX_SUBMIT_LABEL_LENGTH,
  validateAuthoredMissionType,
  type AuthoredMissionType,
  type MissionConfigIssue,
} from '../../src/mission-type/index.ts';

/** A built type with nothing wrong with it, to change one thing at a time. */
function soundType(): AuthoredMissionType {
  return {
    key: 'bird-count',
    version: '1.0.0',
    name: 'Bird count',
    description: 'Teams count the birds they see at one spot.',
    status: 'draft',
    capabilities: ['location'],
    configSchema: {
      type: 'object',
      properties: {
        species: { type: 'string', title: 'Species', minLength: 1 },
        answer: { type: 'integer', minimum: 0 },
      },
      required: ['species'],
    },
    submissionSchema: {
      type: 'object',
      properties: { count: { type: 'integer', minimum: 0 } },
      required: ['count'],
    },
    defaultConfig: { species: 'Robin' },
    validationMethod: 'teacher',
    defaultScoring: { basePoints: 10, allowPartialCredit: false, maxPoints: 15 },
    studentLayout: {
      blocks: [
        { kind: 'brief' },
        { kind: 'config-field', field: 'species', heading: 'Look for' },
        { kind: 'submission' },
      ],
      submitLabel: 'Send count',
    },
  };
}

function issuesOf(value: unknown): MissionConfigIssue[] {
  const result = validateAuthoredMissionType(value);
  assert.equal(result.valid, false, 'expected the mission type to be refused');
  return result.valid ? [] : result.issues;
}

function onlyIssue(value: unknown): MissionConfigIssue {
  const issues = issuesOf(value);
  assert.equal(issues.length, 1, `expected one issue, got ${JSON.stringify(issues)}`);
  return issues[0] as MissionConfigIssue;
}

describe('a built mission type', () => {
  it('passes when nothing is wrong', () => {
    assert.deepEqual(validateAuthoredMissionType(soundType()), { valid: true });
  });

  it('passes with the defaults the migration gives an old row', () => {
    const type = { ...soundType(), ...DEFAULT_MISSION_TYPE_AUTHORING };
    assert.deepEqual(validateAuthoredMissionType(type), { valid: true });
  });

  it('still runs the registry check, and reports both kinds of problem at once', () => {
    const type = { ...soundType(), key: 'Bird Count', validationMethod: 'robot' };
    const paths = issuesOf(type).map((issue) => issue.path);
    assert.deepEqual(paths, ['key', 'validationMethod']);
  });

  it('refuses something that is not an object', () => {
    assert.equal(onlyIssue([]).code, 'not-an-object');
  });
});

describe('the validation method', () => {
  for (const method of ['automatic', 'teacher', 'automatic-with-review'] as const) {
    it(`accepts ${method}`, () => {
      assert.deepEqual(
        validateAuthoredMissionType({ ...soundType(), validationMethod: method }),
        { valid: true },
      );
    });
  }

  it('refuses a word that is not a verification mode', () => {
    const issue = onlyIssue({ ...soundType(), validationMethod: 'ai' });
    assert.equal(issue.path, 'validationMethod');
    assert.equal(issue.code, 'not-allowed-value');
  });

  it('refuses a missing one', () => {
    const { validationMethod: _dropped, ...type } = soundType();
    assert.equal(onlyIssue(type).path, 'validationMethod');
  });
});

describe('the default scoring', () => {
  const scoring = (value: unknown) => ({ ...soundType(), defaultScoring: value });

  it('needs base points', () => {
    const issue = onlyIssue(scoring({ allowPartialCredit: true }));
    assert.equal(issue.path, 'defaultScoring.basePoints');
    assert.equal(issue.code, 'missing');
  });

  it('refuses negative and fractional points', () => {
    assert.equal(onlyIssue(scoring({ basePoints: -1, allowPartialCredit: false })).code, 'out-of-range');
    assert.equal(onlyIssue(scoring({ basePoints: 1.5, allowPartialCredit: false })).code, 'not-an-integer');
  });

  it('refuses a cap below the base', () => {
    const issue = onlyIssue(scoring({ basePoints: 10, allowPartialCredit: false, maxPoints: 5 }));
    assert.equal(issue.path, 'defaultScoring.maxPoints');
    assert.equal(issue.code, 'inconsistent');
  });

  it('needs partial credit to be true or false', () => {
    assert.equal(onlyIssue(scoring({ basePoints: 1 })).path, 'defaultScoring.allowPartialCredit');
  });

  it('refuses a field it does not know', () => {
    const issue = onlyIssue(scoring({ basePoints: 1, allowPartialCredit: false, bonus: 2 }));
    assert.equal(issue.path, 'defaultScoring.bonus');
    assert.equal(issue.code, 'unknown-field');
  });
});

describe('the student layout', () => {
  const layout = (blocks: unknown, submitLabel: unknown = 'Go') => ({
    ...soundType(),
    studentLayout: { blocks, submitLabel },
  });

  it('needs a place to hand work in', () => {
    const issue = onlyIssue(layout([{ kind: 'brief' }]));
    assert.equal(issue.path, 'studentLayout.blocks');
    assert.equal(issue.code, 'missing');
  });

  it('shows each kind of block once', () => {
    const issue = onlyIssue(layout([{ kind: 'submission' }, { kind: 'submission' }]));
    assert.equal(issue.path, 'studentLayout.blocks[1].kind');
    assert.equal(issue.code, 'duplicate-item');
  });

  it('refuses a block kind it does not know', () => {
    const issue = onlyIssue(layout([{ kind: 'video-call' }, { kind: 'submission' }]));
    assert.equal(issue.path, 'studentLayout.blocks[0].kind');
    assert.equal(issue.code, 'not-allowed-value');
  });

  it('places only fields the config schema has', () => {
    const issue = onlyIssue(layout([{ kind: 'config-field', field: 'colour' }, { kind: 'submission' }]));
    assert.equal(issue.path, 'studentLayout.blocks[0].field');
    assert.equal(issue.code, 'inconsistent');
  });

  it('places a field once', () => {
    const issue = onlyIssue(
      layout([
        { kind: 'config-field', field: 'species' },
        { kind: 'config-field', field: 'species' },
        { kind: 'submission' },
      ]),
    );
    assert.equal(issue.path, 'studentLayout.blocks[1].field');
    assert.equal(issue.code, 'duplicate-item');
  });

  it('may show several different fields', () => {
    assert.deepEqual(
      validateAuthoredMissionType(
        layout([
          { kind: 'config-field', field: 'species' },
          { kind: 'config-field', field: 'answer' },
          { kind: 'submission' },
        ]),
      ),
      { valid: true },
    );
  });

  it('does not blame the layout for a schema that is already refused', () => {
    const type = { ...soundType(), configSchema: { type: 'object', oneOf: [] } };
    const paths = issuesOf(type).map((issue) => issue.path);
    assert.ok(paths.every((path) => !path.startsWith('studentLayout')), JSON.stringify(paths));
  });

  it('refuses a field on a block that does not take one', () => {
    const issue = onlyIssue(layout([{ kind: 'brief', field: 'species' }, { kind: 'submission' }]));
    assert.equal(issue.path, 'studentLayout.blocks[0].field');
    assert.equal(issue.code, 'unknown-field');
  });

  it('needs words on the submit button, and not too many', () => {
    assert.equal(onlyIssue(layout([{ kind: 'submission' }], '  ')).code, 'empty-string');
    assert.equal(
      onlyIssue(layout([{ kind: 'submission' }], 'x'.repeat(MAX_SUBMIT_LABEL_LENGTH + 1))).code,
      'too-long',
    );
  });

  it('holds a limited number of blocks', () => {
    const blocks = Array.from({ length: MAX_LAYOUT_BLOCKS + 1 }, () => ({ kind: 'brief' }));
    assert.equal(onlyIssue(layout(blocks)).code, 'too-long');
  });
});

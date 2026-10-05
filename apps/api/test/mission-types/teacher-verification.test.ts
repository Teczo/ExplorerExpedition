/**
 * The teacher verification mission type (EXPD-037), through the registry that holds it.
 *
 * Everything here goes the way a real mission does: the config and the
 * submission are checked against the type's own schemas first, then the
 * config is prepared once and each hand-in is referred with it.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createMissionTypeRegistry, type MissionEvaluation } from '@explorer/engine';
import {
  validateAuthoredMissionType,
  validateMissionTypeDefinition,
  type JsonObject,
} from '@explorer/shared-types';

import {
  PLATFORM_MISSION_TYPES,
  TEACHER_VERIFICATION_AUTHORING,
  TEACHER_VERIFICATION_KEY,
  TEACHER_VERIFICATION_VERSION,
  teacherVerification,
} from '../../src/mission-types/platform/index.ts';

const registry = createMissionTypeRegistry([teacherVerification]);
const KEY = TEACHER_VERIFICATION_KEY;
const VERSION = TEACHER_VERIFICATION_VERSION;

const POEM = {
  checklist: ['Every member says one verse.', ' Nobody reads from a sheet. ', '  '],
};

/** Checks both halves the way the API does, then refers one hand-in. */
function judge(config: JsonObject, submission: JsonObject): MissionEvaluation {
  const behaviour = registry.behaviourFor(KEY, VERSION);
  assert.notEqual(behaviour, undefined);
  return behaviour!.evaluate({
    config,
    prepared: registry.prepareConfig(KEY, VERSION, config),
    submission,
    attemptNumber: 1,
  });
}

describe('teacher verification as a mission type', () => {
  test('is a valid definition, and a valid authored type', () => {
    assert.equal(validateMissionTypeDefinition(teacherVerification.definition).valid, true);
    assert.equal(
      validateAuthoredMissionType({
        ...teacherVerification.definition,
        ...TEACHER_VERIFICATION_AUTHORING,
      }).valid,
      true,
    );
  });

  test('asks a phone for nothing', () => {
    assert.deepEqual(teacherVerification.definition.capabilities, []);
  });

  test('is one of the types the platform ships as code', () => {
    assert.ok(PLATFORM_MISSION_TYPES.includes(teacherVerification));
  });

  test('starts an author with settings its own schema accepts', () => {
    assert.equal(
      registry.validateConfig(KEY, VERSION, teacherVerification.definition.defaultConfig).valid,
      true,
    );
  });

  test('shows the team the checklist', () => {
    const fields = TEACHER_VERIFICATION_AUTHORING.studentLayout.blocks.flatMap((block) =>
      block.kind === 'config-field' ? [block.field] : [],
    );
    assert.deepEqual(fields, ['checklist']);
  });
});

describe('what an author may write', () => {
  const check = (config: JsonObject) => registry.validateConfig(KEY, VERSION, config);

  test('has to give at least one thing to check, and at most ten', () => {
    assert.equal(check({ checklist: ['Show the knot.'] }).valid, true);
    assert.equal(check({}).valid, false);
    assert.equal(check({ checklist: [] }).valid, false);
    assert.equal(check({ checklist: Array.from({ length: 11 }, () => 'x') }).valid, false);
  });

  test('may not write a blank line', () => {
    assert.equal(check({ checklist: ['   '] }).valid, false);
  });
});

describe('what a team may hand in', () => {
  const check = (submission: JsonObject) => registry.validateSubmission(KEY, VERSION, submission);

  test('has to say it is ready, and may add a note', () => {
    assert.equal(check({ ready: true }).valid, true);
    assert.equal(check({ ready: true, note: 'We are by the oak.' }).valid, true);
    assert.equal(check({}).valid, false);
    assert.equal(check({ ready: false }).valid, false);
    assert.equal(check({ ready: true, note: 'x'.repeat(281) }).valid, false);
  });

  test('may not approve itself', () => {
    assert.equal(check({ ready: true, approved: true }).valid, false);
  });
});

describe('what a hand-in becomes', () => {
  test('always waits for a facilitator', () => {
    const verdict = judge(POEM, { ready: true });
    assert.equal(verdict.outcome, 'needs-review');
    assert.equal(verdict.progress, undefined);
    assert.equal(
      verdict.feedback,
      'Ready. Your teacher will check it and approve it or send it back.',
    );
  });

  test('carries the checklist and the team note to the facilitator', () => {
    assert.deepEqual(judge(POEM, { ready: true, note: 'By the oak.' }).detail, {
      checklist: ['Every member says one verse.', 'Nobody reads from a sheet.'],
      note: 'By the oak.',
    });
  });

  test('leaves a blank note out', () => {
    assert.deepEqual(judge(POEM, { ready: true, note: '  ' }).detail, {
      checklist: ['Every member says one verse.', 'Nobody reads from a sheet.'],
    });
  });
});

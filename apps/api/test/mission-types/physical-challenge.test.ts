/**
 * The physical challenge mission type (EXPD-034), through the registry that
 * holds it.
 *
 * Everything here goes the way a real mission does: the config and the
 * submission are checked against the type's own schemas first, then the
 * config is prepared once and each hand-in is judged against it.
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
  PHYSICAL_CHALLENGE_AUTHORING,
  PHYSICAL_CHALLENGE_KEY,
  PHYSICAL_CHALLENGE_VERSION,
  PLATFORM_MISSION_TYPES,
  physicalChallenge,
} from '../../src/mission-types/platform/index.ts';

const registry = createMissionTypeRegistry([physicalChallenge]);

const BRIDGE = {
  activity: 'build',
  steps: ['Collect ten sticks.', 'Build a bridge between the two benches.'],
  doneWhen: ['A tennis ball rolls across it'],
};

const TOWER = {
  activity: 'build',
  steps: ['Build a tower from the cups.'],
  measure: { what: 'Tower height', unit: 'cm', atLeast: 50 },
};

/** Checks both halves the way the API does, then judges one hand-in. */
function judge(config: JsonObject, submission: JsonObject): MissionEvaluation {
  assert.equal(
    registry.validateConfig(PHYSICAL_CHALLENGE_KEY, PHYSICAL_CHALLENGE_VERSION, config).valid,
    true,
  );
  assert.equal(
    registry.validateSubmission(PHYSICAL_CHALLENGE_KEY, PHYSICAL_CHALLENGE_VERSION, submission)
      .valid,
    true,
  );
  const prepared = registry.prepareConfig(PHYSICAL_CHALLENGE_KEY, PHYSICAL_CHALLENGE_VERSION, config);
  const behaviour = registry.behaviourFor(PHYSICAL_CHALLENGE_KEY, PHYSICAL_CHALLENGE_VERSION);
  assert.notEqual(behaviour, undefined);
  return behaviour!.evaluate({ config, prepared, submission, attemptNumber: 1 });
}

describe('the physical challenge as a mission type', () => {
  test('is a valid definition, and a valid authored type', () => {
    assert.equal(validateMissionTypeDefinition(physicalChallenge.definition).valid, true);
    assert.equal(
      validateAuthoredMissionType({
        ...physicalChallenge.definition,
        ...PHYSICAL_CHALLENGE_AUTHORING,
      }).valid,
      true,
    );
  });

  test('asks a phone for nothing', () => {
    assert.deepEqual(physicalChallenge.definition.capabilities, []);
  });

  test('is one of the types the platform ships as code', () => {
    assert.ok(PLATFORM_MISSION_TYPES.includes(physicalChallenge));
  });

  test('starts an author with settings its own schema accepts', () => {
    assert.equal(
      registry.validateConfig(
        PHYSICAL_CHALLENGE_KEY,
        PHYSICAL_CHALLENGE_VERSION,
        physicalChallenge.definition.defaultConfig,
      ).valid,
      true,
    );
  });

  test('shows the team the steps, what done means, and what to measure', () => {
    const fields = PHYSICAL_CHALLENGE_AUTHORING.studentLayout.blocks.filter(
      (block) => block.kind === 'config-field',
    );
    assert.deepEqual(
      fields.map((block) => (block.kind === 'config-field' ? block.field : '')),
      ['steps', 'doneWhen', 'measure'],
    );
  });
});

describe('what an author may write', () => {
  const check = (config: JsonObject) =>
    registry.validateConfig(PHYSICAL_CHALLENGE_KEY, PHYSICAL_CHALLENGE_VERSION, config);

  test('has to say what kind of task it is, and what to do', () => {
    assert.equal(check(BRIDGE).valid, true);
    assert.equal(check({ steps: ['Run.'] }).valid, false);
    assert.equal(check({ activity: 'move' }).valid, false);
    assert.equal(check({ activity: 'move', steps: [] }).valid, false);
  });

  test('picks build, move or skill, and nothing else', () => {
    for (const activity of ['build', 'move', 'skill']) {
      assert.equal(check({ activity, steps: ['Go.'] }).valid, true);
    }
    assert.equal(check({ activity: 'dance', steps: ['Go.'] }).valid, false);
  });

  test('may not write a blank step or a blank "done when"', () => {
    assert.equal(check({ activity: 'move', steps: ['   '] }).valid, false);
    assert.equal(check({ activity: 'move', steps: ['Go.'], doneWhen: [''] }).valid, false);
  });

  test('may list at most twenty steps', () => {
    const steps = Array.from({ length: 21 }, (_, index) => `Step ${index + 1}`);
    assert.equal(check({ activity: 'move', steps: steps.slice(0, 20) }).valid, true);
    assert.equal(check({ activity: 'move', steps }).valid, false);
  });

  test('names a measure and its unit when there is one', () => {
    assert.equal(check(TOWER).valid, true);
    assert.equal(check({ ...TOWER, measure: { what: 'Tower height' } }).valid, false);
    assert.equal(check({ ...TOWER, measure: { what: ' ', unit: 'cm' } }).valid, false);
    assert.equal(check({ ...TOWER, measure: { ...TOWER.measure, atLeast: 'fifty' } }).valid, false);
  });
});

describe('what a team may send', () => {
  const check = (submission: JsonObject) =>
    registry.validateSubmission(PHYSICAL_CHALLENGE_KEY, PHYSICAL_CHALLENGE_VERSION, submission);

  test('has to say the challenge is done', () => {
    assert.equal(check({ done: true }).valid, true);
    assert.equal(check({}).valid, false);
    assert.equal(check({ done: false }).valid, false);
  });

  test('may add a number and a short note', () => {
    assert.equal(check({ done: true, result: 52.5, note: 'Wobbly.' }).valid, true);
    assert.equal(check({ done: true, result: '52' }).valid, false);
    assert.equal(check({ done: true, note: 'x'.repeat(281) }).valid, false);
  });
});

describe('judging a challenge', () => {
  test('sends it to a teacher by default, because code cannot watch the team', () => {
    const evaluation = judge(BRIDGE, { done: true });
    assert.equal(evaluation.outcome, 'needs-review');
    assert.equal(evaluation.feedback, 'Challenge handed in. Your teacher will check it.');
    assert.equal(evaluation.progress, undefined);
  });

  test('keeps what done means and the note, for whoever reviews it', () => {
    const evaluation = judge(
      { ...BRIDGE, doneWhen: ['  A tennis ball rolls across it  '] },
      { done: true, note: 'It held!' },
    );
    assert.deepEqual(evaluation.detail, {
      activity: 'build',
      doneWhen: ['A tennis ball rolls across it'],
      note: 'It held!',
    });
  });

  test('counts it straight away when the author said no review is needed', () => {
    const evaluation = judge({ ...BRIDGE, acceptWithoutReview: true }, { done: true });
    assert.equal(evaluation.outcome, 'correct');
    assert.equal(evaluation.progress, 1);
    assert.equal(evaluation.feedback, 'Challenge complete.');
  });

  test('ignores a number when nothing is measured', () => {
    const evaluation = judge({ ...BRIDGE, acceptWithoutReview: true }, { done: true, result: 3 });
    assert.equal(evaluation.outcome, 'correct');
    assert.equal(evaluation.detail?.['result'], undefined);
  });

  test('gives the same answer twice', () => {
    assert.deepEqual(judge(TOWER, { done: true, result: 60 }), judge(TOWER, { done: true, result: 60 }));
  });
});

describe('judging a measured challenge', () => {
  test('asks for the result when the team leaves it out', () => {
    const evaluation = judge(TOWER, { done: true });
    assert.equal(evaluation.outcome, 'incorrect');
    assert.equal(evaluation.feedback, 'Enter your tower height in cm, then hand it in.');
    assert.equal(evaluation.detail?.['result'], null);
  });

  test('turns a result under the target away, and says the target', () => {
    const evaluation = judge(TOWER, { done: true, result: 35 });
    assert.equal(evaluation.outcome, 'incorrect');
    assert.equal(evaluation.feedback, 'Not yet: 35 cm. Tower height has to be at least 50 cm.');
    assert.equal(evaluation.progress, 0.7);
  });

  test('sends a result that meets the target to a teacher, with the result', () => {
    const evaluation = judge(TOWER, { done: true, result: 50 });
    assert.equal(evaluation.outcome, 'needs-review');
    assert.deepEqual(evaluation.detail, {
      activity: 'build',
      doneWhen: [],
      measure: 'Tower height',
      unit: 'cm',
      result: 50,
    });
  });

  test('counts a result that meets the target at once, when no review is needed', () => {
    const evaluation = judge({ ...TOWER, acceptWithoutReview: true }, { done: true, result: 64 });
    assert.equal(evaluation.outcome, 'correct');
    assert.equal(evaluation.progress, 1);
  });

  test('holds a ceiling, with no partial progress over it', () => {
    const lap = {
      activity: 'move',
      steps: ['Run to the oak and back.'],
      measure: { what: 'Time', unit: 'seconds', atMost: 60 },
      acceptWithoutReview: true,
    };
    assert.equal(judge(lap, { done: true, result: 58 }).outcome, 'correct');
    const slow = judge(lap, { done: true, result: 75 });
    assert.equal(slow.outcome, 'incorrect');
    assert.equal(slow.progress, 0);
    assert.equal(slow.feedback, 'Not yet: 75 seconds. Time has to be at most 60 seconds.');
  });

  test('holds a range, and reads a floor above the ceiling as the range between them', () => {
    const pour = {
      activity: 'skill',
      steps: ['Pour the water by eye.'],
      measure: { what: 'Water', unit: 'ml', atLeast: 260, atMost: 240 },
      acceptWithoutReview: true,
    };
    assert.equal(judge(pour, { done: true, result: 250 }).outcome, 'correct');
    const over = judge(pour, { done: true, result: 300 });
    assert.equal(over.outcome, 'incorrect');
    assert.equal(over.feedback, 'Not yet: 300 ml. Water has to be between 240 and 260 ml.');
  });

  test('treats a measure with no target as a number to record', () => {
    const evaluation = judge(
      { ...BRIDGE, measure: { what: 'Sticks used', unit: 'sticks' }, acceptWithoutReview: true },
      { done: true, result: 9 },
    );
    assert.equal(evaluation.outcome, 'correct');
    assert.equal(evaluation.detail?.['result'], 9);
  });
});

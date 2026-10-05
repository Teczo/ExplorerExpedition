/**
 * The timed challenge mission type (EXPD-036), through the registry that holds it.
 *
 * Everything here goes the way a real mission does: the config and the
 * submission are checked against the type's own schemas first, then the
 * config is prepared once and each hand-in is judged against it, with the
 * time the engine measured.
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
  TIMED_CHALLENGE_AUTHORING,
  TIMED_CHALLENGE_KEY,
  TIMED_CHALLENGE_VERSION,
  clockTime,
  timedChallenge,
} from '../../src/mission-types/platform/index.ts';

const registry = createMissionTypeRegistry([timedChallenge]);

/** Full points inside a minute, nothing from three minutes on. */
const RELAY = {
  steps: ['Run to the bandstand.', 'Touch the post.', 'Run back.'],
  fullPointsWithinSeconds: 60,
  pointsRunOutAtSeconds: 180,
};

const FINISH_POST = { ...RELAY, finishCode: 'Kestrel 42' };

/** Checks both halves the way the API does, then judges one hand-in. */
function judge(
  config: JsonObject,
  submission: JsonObject,
  elapsedSeconds: number | undefined,
): MissionEvaluation {
  assert.equal(
    registry.validateConfig(TIMED_CHALLENGE_KEY, TIMED_CHALLENGE_VERSION, config).valid,
    true,
  );
  assert.equal(
    registry.validateSubmission(TIMED_CHALLENGE_KEY, TIMED_CHALLENGE_VERSION, submission).valid,
    true,
  );
  const prepared = registry.prepareConfig(TIMED_CHALLENGE_KEY, TIMED_CHALLENGE_VERSION, config);
  const behaviour = registry.behaviourFor(TIMED_CHALLENGE_KEY, TIMED_CHALLENGE_VERSION);
  assert.notEqual(behaviour, undefined);
  return behaviour!.evaluate({
    config,
    prepared,
    submission,
    attemptNumber: 1,
    ...(elapsedSeconds === undefined ? {} : { elapsedSeconds }),
  });
}

describe('the timed challenge as a mission type', () => {
  test('is a valid definition, and a valid authored type', () => {
    assert.equal(validateMissionTypeDefinition(timedChallenge.definition).valid, true);
    assert.equal(
      validateAuthoredMissionType({ ...timedChallenge.definition, ...TIMED_CHALLENGE_AUTHORING })
        .valid,
      true,
    );
  });

  test('asks a phone for nothing', () => {
    assert.deepEqual(timedChallenge.definition.capabilities, []);
  });

  test('is one of the types the platform ships as code', () => {
    assert.ok(PLATFORM_MISSION_TYPES.includes(timedChallenge));
  });

  test('starts an author with settings its own schema accepts', () => {
    assert.equal(
      registry.validateConfig(
        TIMED_CHALLENGE_KEY,
        TIMED_CHALLENGE_VERSION,
        timedChallenge.definition.defaultConfig,
      ).valid,
      true,
    );
  });

  test('starts with partial credit on, so the time is paid for', () => {
    assert.equal(TIMED_CHALLENGE_AUTHORING.defaultScoring.allowPartialCredit, true);
  });

  test('shows the team the steps and the full-points time, and never the finish code', () => {
    const fields = TIMED_CHALLENGE_AUTHORING.studentLayout.blocks.flatMap((block) =>
      block.kind === 'config-field' ? [block.field] : [],
    );
    assert.deepEqual(fields, ['steps', 'fullPointsWithinSeconds']);
  });
});

describe('what an author may write', () => {
  const check = (config: JsonObject) =>
    registry.validateConfig(TIMED_CHALLENGE_KEY, TIMED_CHALLENGE_VERSION, config);

  test('has to give the steps and both times', () => {
    assert.equal(check(RELAY).valid, true);
    const { steps: _s, ...noSteps } = RELAY;
    assert.equal(check(noSteps).valid, false);
    const { fullPointsWithinSeconds: _f, ...noFull } = RELAY;
    assert.equal(check(noFull).valid, false);
    const { pointsRunOutAtSeconds: _o, ...noRunOut } = RELAY;
    assert.equal(check(noRunOut).valid, false);
  });

  test('gives times as whole seconds, at least one', () => {
    assert.equal(check({ ...RELAY, fullPointsWithinSeconds: 0 }).valid, false);
    assert.equal(check({ ...RELAY, fullPointsWithinSeconds: 1.5 }).valid, false);
    assert.equal(check({ ...RELAY, pointsRunOutAtSeconds: -10 }).valid, false);
  });

  test('keeps the minimum share between nought and one', () => {
    assert.equal(check({ ...RELAY, minimumShare: 0.25 }).valid, true);
    assert.equal(check({ ...RELAY, minimumShare: 1.5 }).valid, false);
    assert.equal(check({ ...RELAY, minimumShare: -0.1 }).valid, false);
  });

  test('may not write a blank step or a blank finish code', () => {
    assert.equal(check({ ...RELAY, steps: ['  '] }).valid, false);
    assert.equal(check({ ...RELAY, finishCode: '   ' }).valid, false);
    assert.equal(check(FINISH_POST).valid, true);
  });
});

describe('what a team may hand in', () => {
  const check = (submission: JsonObject) =>
    registry.validateSubmission(TIMED_CHALLENGE_KEY, TIMED_CHALLENGE_VERSION, submission);

  test('has to say it is done', () => {
    assert.equal(check({ done: true }).valid, true);
    assert.equal(check({ done: true, code: 'KESTREL42' }).valid, true);
    assert.equal(check({}).valid, false);
    assert.equal(check({ done: false }).valid, false);
  });

  test('may not send a time of its own', () => {
    assert.equal(check({ done: true, elapsedSeconds: 5 }).valid, false);
  });
});

describe('what the time is worth', () => {
  test('a finish inside the full-points time earns all of it', () => {
    const verdict = judge(RELAY, { done: true }, 45);
    assert.equal(verdict.outcome, 'correct');
    assert.equal(verdict.progress, 1);
    assert.equal(verdict.feedback, 'Done in 0:45, inside 1:00: full points.');
  });

  test('at the full-points time exactly, it is still all of it', () => {
    assert.equal(judge(RELAY, { done: true }, 60).progress, 1);
  });

  test('the share falls in a straight line to the run-out time', () => {
    const halfway = judge(RELAY, { done: true }, 120);
    assert.equal(halfway.outcome, 'correct');
    assert.equal(halfway.progress, 0.5);
    assert.equal(
      halfway.feedback,
      'Done in 2:00. Full points were inside 1:00; this finish earns 50% of them.',
    );
    assert.equal(judge(RELAY, { done: true }, 150).progress, 0.25);
  });

  test('from the run-out time on, a finish still completes and earns nothing', () => {
    for (const seconds of [180, 600]) {
      const verdict = judge(RELAY, { done: true }, seconds);
      assert.equal(verdict.outcome, 'correct');
      assert.equal(verdict.progress, 0);
    }
  });

  test('never falls below the minimum share', () => {
    const floored = { ...RELAY, minimumShare: 0.2 };
    assert.equal(judge(floored, { done: true }, 120).progress, 0.6);
    assert.equal(judge(floored, { done: true }, 900).progress, 0.2);
  });

  test('a run-out time at or before the full-points time is a cliff', () => {
    const cliff = { ...RELAY, pointsRunOutAtSeconds: 30, minimumShare: 0.5 };
    assert.equal(judge(cliff, { done: true }, 60).progress, 1);
    assert.equal(judge(cliff, { done: true }, 61).progress, 0.5);
  });

  test('keeps the time and the targets in the detail', () => {
    assert.deepEqual(judge(RELAY, { done: true }, 120).detail, {
      elapsedSeconds: 120,
      fullPointsWithinSeconds: 60,
      pointsRunOutAtSeconds: 180,
      share: 0.5,
    });
  });

  test('with no time to read, a person decides rather than a guess', () => {
    const verdict = judge(RELAY, { done: true }, undefined);
    assert.equal(verdict.outcome, 'needs-review');
    assert.equal(verdict.progress, undefined);
  });
});

describe('a finish code', () => {
  test('stops the clock when it matches, in any case and spacing', () => {
    for (const code of ['Kestrel 42', 'KESTREL42', ' kestrel 4 2 ']) {
      assert.equal(judge(FINISH_POST, { done: true, code }, 30).outcome, 'correct');
    }
  });

  test('turns away a wrong code, and never says the right one', () => {
    const verdict = judge(FINISH_POST, { done: true, code: 'falcon' }, 30);
    assert.equal(verdict.outcome, 'incorrect');
    assert.equal(verdict.feedback, 'That is not the finish code. The clock is still running.');
    assert.doesNotMatch(JSON.stringify(verdict), /kestrel/i);
  });

  test('asks for the code when none was sent', () => {
    const verdict = judge(FINISH_POST, { done: true }, 30);
    assert.equal(verdict.outcome, 'incorrect');
    assert.equal(verdict.feedback, 'Enter the code from the finish to stop the clock.');
  });

  test('is ignored when the author set none', () => {
    assert.equal(judge(RELAY, { done: true, code: 'anything' }, 30).outcome, 'correct');
  });
});

describe('how a time is written for the team', () => {
  test('minutes and seconds, and hours when there are any', () => {
    assert.equal(clockTime(0), '0:00');
    assert.equal(clockTime(9.6), '0:10');
    assert.equal(clockTime(125), '2:05');
    assert.equal(clockTime(3750), '1:02:30');
  });
});

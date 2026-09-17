/**
 * Every square of the board.
 *
 * The ticket asks for transitions that are explicit. The strongest way to
 * hold that to account is to write down what all eighty-eight state-and-
 * trigger pairs do — eight states by eleven triggers — and check every one.
 * A new edge added to the machine without a decision behind it fails here,
 * because the expected answer for that square is written out below and would
 * disagree.
 *
 * The matrix runs under the most permissive policy there is: unlimited tries
 * and skipping allowed. What the two settings in a policy change is
 * `attempts.test.ts` and `policy.test.ts`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MISSION_STATES,
  MISSION_TRIGGERS,
  toId,
  type MissionInstanceId,
  type MissionState,
  type MissionTrigger,
} from '@explorer/shared-types';

import {
  allowedMissionTriggers,
  applyMissionTransition,
  createMissionProgress,
  MISSION_TRANSITIONS,
  missionStateAfter,
  type MissionStatePolicy,
} from '../../src/mission-state/index.ts';

const MISSION: MissionInstanceId = toId('mission-1');
const PERMISSIVE: MissionStatePolicy = { maxAttempts: null, allowSkip: true };
const AT = '2026-09-17T09:00:00.000Z';

/**
 * Where each trigger leaves each state, when it is allowed at all.
 *
 * Anything not written here is refused. Read it as the diagram: a row is a
 * state, and what is under it is every way out of it.
 */
const EXPECTED: Readonly<Record<MissionState, Partial<Record<MissionTrigger, MissionState>>>> = {
  locked: { unlock: 'available' },
  available: { relock: 'locked', start: 'in-progress', skip: 'skipped' },
  'in-progress': { submit: 'submitted', expire: 'failed', skip: 'skipped' },
  submitted: {
    accept: 'complete',
    reject: 'available',
    refer: 'awaiting-verification',
  },
  'awaiting-verification': { verify: 'complete', overrule: 'available' },
  complete: {},
  failed: {},
  skipped: {},
};

/** A fresh mission put straight into one state, with no tries used. */
function sitting(state: MissionState) {
  return createMissionProgress(MISSION, { state });
}

describe('every state and every trigger', () => {
  for (const state of MISSION_STATES) {
    for (const trigger of MISSION_TRIGGERS) {
      const expected = EXPECTED[state][trigger];

      if (expected === undefined) {
        it(`refuses ${trigger} on a ${state} mission`, () => {
          const result = applyMissionTransition(
            sitting(state),
            { trigger, actor: 'engine', at: AT },
            PERMISSIVE,
          );
          assert.equal(result.applied, false);
          assert.equal(
            result.applied === false && result.refusal.code,
            state === 'complete' || state === 'failed' || state === 'skipped'
              ? 'terminal-state'
              : 'wrong-state',
          );
        });
        continue;
      }

      it(`moves a ${state} mission to ${expected} on ${trigger}`, () => {
        const result = applyMissionTransition(
          sitting(state),
          { trigger, actor: 'engine', at: AT },
          PERMISSIVE,
        );
        assert.equal(result.applied, true);
        assert.equal(result.progress.state, expected);
      });
    }
  }
});

describe('the table itself', () => {
  it('has a row for every trigger and no row for anything else', () => {
    assert.deepEqual(Object.keys(MISSION_TRANSITIONS).sort(), [...MISSION_TRIGGERS].sort());
  });

  it('never leaves a mission where it already was', () => {
    for (const trigger of MISSION_TRIGGERS) {
      const rule = MISSION_TRANSITIONS[trigger];
      assert.ok(
        !rule.from.includes(rule.to),
        `${trigger} can be applied in the state it moves to`,
      );
    }
  });

  it('has no way out of a finished mission', () => {
    for (const trigger of MISSION_TRIGGERS) {
      for (const state of ['complete', 'failed', 'skipped'] as const) {
        assert.ok(
          !MISSION_TRANSITIONS[trigger].from.includes(state),
          `${trigger} claims to work on a ${state} mission`,
        );
      }
    }
  });
});

describe('asking before doing', () => {
  it('offers exactly what the matrix allows, in trigger order', () => {
    for (const state of MISSION_STATES) {
      const offered = allowedMissionTriggers(sitting(state), PERMISSIVE);
      const expected = MISSION_TRIGGERS.filter(
        (trigger) => EXPECTED[state][trigger] !== undefined,
      );
      assert.deepEqual(offered, expected, state);
    }
  });

  it('says where a trigger would land before it is applied', () => {
    const available = sitting('available');
    assert.equal(missionStateAfter(available, 'skip', PERMISSIVE), 'skipped');
    assert.equal(missionStateAfter(available, 'start', PERMISSIVE), 'in-progress');
    assert.equal(missionStateAfter(available, 'submit', PERMISSIVE), undefined);
  });

  it('offers a finished mission nothing at all', () => {
    assert.deepEqual(allowedMissionTriggers(sitting('complete'), PERMISSIVE), []);
    assert.deepEqual(allowedMissionTriggers(sitting('failed'), PERMISSIVE), []);
    assert.deepEqual(allowedMissionTriggers(sitting('skipped'), PERMISSIVE), []);
  });
});

describe('a word that is not a trigger', () => {
  it('is refused rather than thrown', () => {
    const result = applyMissionTransition(
      sitting('available'),
      { trigger: 'finish', actor: 'team', at: AT },
      PERMISSIVE,
    );
    assert.equal(result.applied, false);
    assert.equal(result.applied === false && result.refusal.code, 'unknown-trigger');
    assert.equal(result.applied === false && result.refusal.trigger, 'finish');
  });

  it('says what the triggers are, so the caller can see the typo', () => {
    const result = applyMissionTransition(
      sitting('available'),
      { trigger: 'Start', actor: 'team', at: AT },
      PERMISSIVE,
    );
    assert.ok(result.applied === false && result.refusal.message.includes('start'));
  });
});

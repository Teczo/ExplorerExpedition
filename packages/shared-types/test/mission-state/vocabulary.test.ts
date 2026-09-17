/**
 * The words themselves.
 *
 * The state machine's rules are tested in the engine. What is tested here is
 * the vocabulary every app reads: that the eight states the ticket names are
 * the eight states, that nothing has quietly been added, and that the guards
 * anything can call to check an unknown string really do refuse one.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isMissionState,
  isMissionTransitionActor,
  isMissionTrigger,
  isPendingMissionState,
  isTerminalMissionState,
  MISSION_STATES,
  MISSION_TRANSITION_ACTORS,
  MISSION_TRIGGERS,
  TERMINAL_MISSION_STATES,
} from '../../src/index.ts';

describe('the states a mission can be in', () => {
  it('is the eight the ticket names, in play order', () => {
    assert.deepEqual([...MISSION_STATES], [
      'locked',
      'available',
      'in-progress',
      'submitted',
      'awaiting-verification',
      'complete',
      'failed',
      'skipped',
    ]);
  });

  it('holds no word twice', () => {
    assert.equal(new Set(MISSION_STATES).size, MISSION_STATES.length);
  });

  it('recognises its own words and nothing else', () => {
    for (const state of MISSION_STATES) {
      assert.equal(isMissionState(state), true, state);
    }
    assert.equal(isMissionState('in progress'), false);
    assert.equal(isMissionState('awaiting-review'), false);
    assert.equal(isMissionState(undefined), false);
    assert.equal(isMissionState(3), false);
  });

  it('calls three of them final, and only three', () => {
    assert.deepEqual([...TERMINAL_MISSION_STATES], ['complete', 'failed', 'skipped']);
    for (const state of MISSION_STATES) {
      assert.equal(
        isTerminalMissionState(state),
        (TERMINAL_MISSION_STATES as readonly string[]).includes(state),
        state,
      );
    }
  });

  it('calls the two a team is waiting through pending', () => {
    const pending = MISSION_STATES.filter(isPendingMissionState);
    assert.deepEqual(pending, ['submitted', 'awaiting-verification']);
  });
});

describe('what moves a mission', () => {
  it('is the eleven triggers, in the order the table walks them', () => {
    assert.deepEqual([...MISSION_TRIGGERS], [
      'unlock',
      'relock',
      'start',
      'submit',
      'accept',
      'reject',
      'refer',
      'verify',
      'overrule',
      'expire',
      'skip',
    ]);
  });

  it('holds no word twice', () => {
    assert.equal(new Set(MISSION_TRIGGERS).size, MISSION_TRIGGERS.length);
  });

  it('recognises its own words and nothing else', () => {
    for (const trigger of MISSION_TRIGGERS) {
      assert.equal(isMissionTrigger(trigger), true, trigger);
    }
    assert.equal(isMissionTrigger('complete'), false);
    assert.equal(isMissionTrigger('SUBMIT'), false);
    assert.equal(isMissionTrigger(null), false);
  });

  it('names three sides of the game, and no more', () => {
    assert.deepEqual([...MISSION_TRANSITION_ACTORS], ['team', 'engine', 'teacher']);
    assert.equal(isMissionTransitionActor('teacher'), true);
    assert.equal(isMissionTransitionActor('service'), false);
  });
});

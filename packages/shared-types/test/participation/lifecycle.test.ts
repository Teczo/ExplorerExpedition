/**
 * The order the states of a run come in.
 *
 * The table is the whole of this ticket's opinion about what a teacher may do
 * next, and three sides read it: the API enforces it, Director Mode draws
 * buttons from it, and the student app is told what a change means. So it is
 * tested where it lives rather than through one of them.
 *
 * Two things matter most and are easy to lose. Every state a run can be in
 * has an entry, including the two that lead nowhere — a missing entry would
 * be a crash at the moment somebody presses *end* twice. And the two final
 * states are exactly the two states a join code cannot reach, because a run
 * nobody can join is a run nobody can rejoin either.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  canSessionMove,
  FINAL_SESSION_STATUSES,
  isFinalSessionStatus,
  isLiveSessionStatus,
  isPregameSessionStatus,
  JOINABLE_SESSION_STATUSES,
  LIVE_SESSION_STATUSES,
  PREGAME_SESSION_STATUSES,
  SESSION_COMMANDS,
  SESSION_STATUSES,
  SESSION_TRANSITIONS,
  sessionStatusAfter,
  type SessionStatus,
} from '../../src/index.ts';

describe('the transition table', () => {
  it('has an entry for every state a run can be in', () => {
    assert.deepEqual(
      Object.keys(SESSION_TRANSITIONS).sort(),
      [...SESSION_STATUSES].sort(),
    );
  });

  it('never points at a state that is not one', () => {
    for (const [from, next] of Object.entries(SESSION_TRANSITIONS)) {
      for (const to of next) {
        assert.ok(
          (SESSION_STATUSES as readonly string[]).includes(to),
          `${from} points at ${to}`,
        );
      }
    }
  });

  it('lets a run that has not started be started or called off', () => {
    for (const from of PREGAME_SESSION_STATUSES) {
      assert.ok(canSessionMove(from, 'running'), from);
      assert.ok(canSessionMove(from, 'cancelled'), from);
    }
  });

  it('lets a run being played be paused, resumed and ended', () => {
    assert.ok(canSessionMove('running', 'paused'));
    assert.ok(canSessionMove('paused', 'running'));
    assert.ok(canSessionMove('running', 'ended'));
    assert.ok(canSessionMove('paused', 'ended'));
  });

  it('leads nowhere from a run that is over', () => {
    for (const from of FINAL_SESSION_STATUSES) {
      assert.deepEqual(SESSION_TRANSITIONS[from], []);
      for (const to of SESSION_STATUSES) {
        assert.equal(canSessionMove(from, to), false, `${from} to ${to}`);
      }
    }
  });

  it('never reopens a run, and never cancels one that was played', () => {
    assert.equal(canSessionMove('running', 'cancelled'), false);
    assert.equal(canSessionMove('paused', 'lobby'), false);
    assert.equal(canSessionMove('running', 'scheduled'), false);
  });
});

describe('what a command leaves a run in', () => {
  it('starts a run that has not been played', () => {
    for (const from of PREGAME_SESSION_STATUSES) {
      assert.equal(sessionStatusAfter(from, 'start', { started: false }), 'running');
    }
  });

  it('pauses and resumes a run that is being played', () => {
    assert.equal(sessionStatusAfter('running', 'pause', { started: true }), 'paused');
    assert.equal(sessionStatusAfter('paused', 'resume', { started: true }), 'running');
  });

  it('ends a run that was played and cancels one that was not', () => {
    assert.equal(sessionStatusAfter('running', 'end', { started: true }), 'ended');
    assert.equal(sessionStatusAfter('lobby', 'end', { started: false }), 'cancelled');
    assert.equal(sessionStatusAfter('scheduled', 'end', { started: false }), 'cancelled');
  });

  it('leaves an extended run exactly where it was', () => {
    assert.equal(sessionStatusAfter('running', 'extend', { started: true }), 'running');
    assert.equal(sessionStatusAfter('paused', 'extend', { started: true }), 'paused');
  });

  it('refuses to extend a run that is not being played', () => {
    for (const from of ['scheduled', 'lobby', 'ended', 'cancelled'] as const) {
      assert.equal(sessionStatusAfter(from, 'extend', { started: false }), null, from);
    }
  });

  it('refuses every command once a run is over', () => {
    for (const from of FINAL_SESSION_STATUSES) {
      for (const command of SESSION_COMMANDS) {
        assert.equal(
          sessionStatusAfter(from, command, { started: true }),
          null,
          `${command} on ${from}`,
        );
      }
    }
  });

  it('refuses a second start, and a resume of a run that is not paused', () => {
    assert.equal(sessionStatusAfter('running', 'start', { started: true }), null);
    assert.equal(sessionStatusAfter('running', 'resume', { started: true }), null);
    assert.equal(sessionStatusAfter('lobby', 'pause', { started: false }), null);
  });
});

describe('the lists a state belongs to', () => {
  it('sorts every state into exactly one of the three', () => {
    for (const status of SESSION_STATUSES) {
      const lists = [
        isPregameSessionStatus(status),
        isLiveSessionStatus(status),
        isFinalSessionStatus(status),
      ].filter(Boolean);

      assert.equal(lists.length, 1, status);
    }
  });

  it('counts a paused run as one being played', () => {
    assert.deepEqual([...LIVE_SESSION_STATUSES], ['running', 'paused']);
  });

  it('makes the final states the ones a join code cannot reach', () => {
    const joinable = new Set<string>(JOINABLE_SESSION_STATUSES);
    const unreachable = SESSION_STATUSES.filter(
      (status: SessionStatus) => !joinable.has(status),
    );

    assert.deepEqual([...unreachable].sort(), [...FINAL_SESSION_STATUSES].sort());
  });

  it('says no to something that is not a state at all', () => {
    for (const value of [null, undefined, 42, 'playing']) {
      assert.equal(isLiveSessionStatus(value), false);
      assert.equal(isFinalSessionStatus(value), false);
      assert.equal(isPregameSessionStatus(value), false);
    }
  });
});

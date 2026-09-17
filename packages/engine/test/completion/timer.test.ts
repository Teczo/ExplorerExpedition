/**
 * Had the mission's own clock run out.
 *
 * The engine holds no clock, so everything here is arithmetic on times a
 * caller passed in. What is tested is that the arithmetic reads the start off
 * the mission's own history rather than being told it, that the deadline is
 * the one the mission's `timeLimitSeconds` sets, and that the mission is over
 * at the deadline rather than a moment after it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyMissionTransition,
  createMissionProgress,
} from '../../src/mission-state/index.ts';
import {
  attemptStartedAt,
  hasMissionExpired,
  missionDeadline,
} from '../../src/completion/timer.ts';
import {
  DEFAULT_MISSION_COMPLETION_POLICY,
  missionCompletionPolicyFor,
  type MissionCompletionPolicy,
} from '../../src/completion/policy.ts';
import { at, missionOf, openedMission, rulesOf } from './support.ts';

const timed: MissionCompletionPolicy = missionCompletionPolicyFor(
  missionOf('code-match', { timeLimitSeconds: 300 }),
  rulesOf(false),
);

describe('when the try that is running now was opened', () => {
  it('is nothing at all before the team has opened it', () => {
    const fresh = createMissionProgress('mission-1' as never, { state: 'available' });
    assert.equal(attemptStartedAt(fresh), undefined);
  });

  it('is the time the team pressed start', () => {
    assert.equal(attemptStartedAt(openedMission('mission-1', undefined, at(45))), at(45));
  });

  it('is this try, not the first one', () => {
    // A mission handed back keeps every line of its history, so the last
    // `start` is the one that matters and the first is not.
    let progress = openedMission('mission-1', undefined, at(0));
    for (const [trigger, when] of [
      ['submit', at(10)],
      ['reject', at(11)],
      ['start', at(600)],
    ] as const) {
      const result = applyMissionTransition(progress, { trigger, actor: 'engine', at: when });
      assert.equal(result.applied, true);
      if (result.applied) {
        progress = result.progress;
      }
    }
    assert.equal(attemptStartedAt(progress), at(600));
  });
});

describe('when a running try runs out of time', () => {
  it('is the start plus the limit the mission sets', () => {
    assert.equal(missionDeadline(timed, openedMission('mission-1')), at(300));
  });

  it('is never, for a mission with no limit of its own', () => {
    assert.equal(
      missionDeadline(DEFAULT_MISSION_COMPLETION_POLICY, openedMission('mission-1')),
      undefined,
    );
  });

  it('is never, before the team has opened it', () => {
    const fresh = createMissionProgress('mission-1' as never, { state: 'available' });
    assert.equal(missionDeadline(timed, fresh), undefined);
  });

  it('is never, when the history holds a time nobody can read', () => {
    // Better to answer "no deadline" than to compare NaN and answer "expired".
    const broken = { ...openedMission('mission-1') };
    const log = [...broken.log];
    log[0] = { ...log[0]!, at: 'half past four' };
    assert.equal(missionDeadline(timed, { ...broken, log }), undefined);
  });
});

describe('whether the clock has run out', () => {
  const progress = openedMission('mission-1');

  it('has not, with a second still on it', () => {
    assert.equal(hasMissionExpired(timed, progress, at(299)), false);
  });

  it('has, at the deadline itself', () => {
    // Five minutes means five minutes. The three-hundredth second is over.
    assert.equal(hasMissionExpired(timed, progress, at(300)), true);
  });

  it('has, after it', () => {
    assert.equal(hasMissionExpired(timed, progress, at(900)), true);
  });

  it('never has, for a mission with no limit of its own', () => {
    assert.equal(
      hasMissionExpired(DEFAULT_MISSION_COMPLETION_POLICY, progress, at(999_999)),
      false,
    );
  });

  it('never has, when the moment given is not a time', () => {
    assert.equal(hasMissionExpired(timed, progress, 'later on'), false);
  });
});

/**
 * A mission type is told how long the team took (EXPD-036).
 *
 * The engine holds no clock, so the time is arithmetic on two times a caller
 * passed in: the `start` in the mission's history, and the `at` the
 * submission is judged at. What is tested is that a behaviour is handed that
 * difference, that it is measured from the try running now, and that it is
 * left out rather than guessed when there is no start to measure from.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { MissionProgress } from '@explorer/shared-types';

import { createMissionTypeRegistry, defineMissionType } from '../../src/mission-types/index.ts';
import { applyMissionTransition } from '../../src/mission-state/index.ts';
import { completeMission } from '../../src/completion/complete.ts';
import { secondsSinceAttemptStarted } from '../../src/completion/timer.ts';
import { at, byHand, missionOf, openedMission } from './support.ts';

/** A type that says what it was told, so the test can read it back. */
const stopwatch = defineMissionType({
  definition: { ...byHand.definition, key: 'stopwatch', name: 'Stopwatch' },
  behaviour: {
    evaluate({ elapsedSeconds }) {
      return {
        outcome: 'correct',
        detail: { elapsedSeconds: elapsedSeconds === undefined ? 'none' : elapsedSeconds },
      };
    },
  },
});

const registry = createMissionTypeRegistry([stopwatch]);
const mission = missionOf('stopwatch');

function told(progress: MissionProgress, when: string): unknown {
  const result = completeMission({
    kind: 'submission',
    registry,
    mission,
    progress,
    payload: {},
    at: when,
  });
  assert.equal(result.applied, true);
  return result.applied ? result.verdict.detail?.['elapsedSeconds'] : undefined;
}

describe('how long the team took, as a mission type is told it', () => {
  it('is the seconds from opening the mission to handing in', () => {
    assert.equal(told(openedMission(mission.id, undefined, at(10)), at(55)), 45);
  });

  it('is measured from the try running now, not the first one', () => {
    let progress = openedMission(mission.id, undefined, at(0));
    for (const [trigger, when] of [
      ['submit', at(5)],
      ['reject', at(6)],
      ['start', at(20)],
    ] as const) {
      const moved = applyMissionTransition(progress, { trigger, actor: 'engine', at: when });
      assert.equal(moved.applied, true);
      if (moved.applied) {
        progress = moved.progress;
      }
    }
    assert.equal(told(progress, at(50)), 30);
  });
});

describe('the arithmetic underneath', () => {
  it('has nothing to say before the team has opened the mission', () => {
    const progress = openedMission(mission.id, undefined, at(0));
    assert.equal(secondsSinceAttemptStarted({ ...progress, log: [] }, at(10)), undefined);
  });

  it('will not measure backwards, or from a time nobody can read', () => {
    const progress = openedMission(mission.id, undefined, at(30));
    assert.equal(secondsSinceAttemptStarted(progress, at(10)), undefined);
    assert.equal(secondsSinceAttemptStarted(progress, 'not a time'), undefined);
  });
});

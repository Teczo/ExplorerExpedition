/**
 * The words a snapshot is said in.
 *
 * The rules that work a snapshot out are tested in the engine. What is tested
 * here is the vocabulary every app reads: the three reasons an edge can be
 * blocked, and the four readers anything can call over a snapshot without
 * knowing how one was made.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isMissionUnlocked,
  isMissionVisible,
  progressionMissionOf,
  progressionNodeOf,
  PROGRESSION_BLOCK_REASONS,
  type MissionInstanceId,
  type NodeId,
  type ProgressionSnapshot,
} from '../../src/index.ts';

/** A snapshot with one mission on one stop, said as plainly as possible. */
const snapshot: ProgressionSnapshot = {
  nodes: [
    {
      nodeId: 'node-alpha' as NodeId,
      kind: 'mission',
      reached: true,
      cleared: false,
      offRoute: false,
      blockedBy: [],
    },
  ],
  missions: [
    {
      missionInstanceId: 'alpha' as MissionInstanceId,
      nodeId: 'node-alpha' as NodeId,
      state: 'available',
      reached: true,
      unlocked: true,
      visible: true,
      optional: false,
      secret: false,
      offRoute: false,
      blockedBy: [],
    },
  ],
  unlockedMissionIds: ['alpha' as MissionInstanceId],
  visibleMissionIds: ['alpha' as MissionInstanceId],
  reachedFinishNodeIds: [],
  finished: false,
};

describe('the reasons an edge can be blocked', () => {
  it('is the three the engine can give, in the order they are told apart', () => {
    assert.deepEqual([...PROGRESSION_BLOCK_REASONS], [
      'not-cleared',
      'condition',
      'off-route',
    ]);
  });

  it('holds no word twice', () => {
    assert.equal(
      new Set(PROGRESSION_BLOCK_REASONS).size,
      PROGRESSION_BLOCK_REASONS.length,
    );
  });
});

describe('reading a snapshot', () => {
  it('finds a mission and the stop that holds it', () => {
    assert.equal(
      progressionMissionOf(snapshot, 'alpha' as MissionInstanceId)?.nodeId,
      'node-alpha',
    );
    assert.equal(progressionNodeOf(snapshot, 'node-alpha' as NodeId)?.kind, 'mission');
  });

  it('answers for a mission this expedition does not place', () => {
    const missing = 'nowhere' as MissionInstanceId;

    assert.equal(progressionMissionOf(snapshot, missing), undefined);
    assert.equal(progressionNodeOf(snapshot, 'nowhere' as NodeId), undefined);
    assert.equal(isMissionUnlocked(snapshot, missing), false);
    assert.equal(isMissionVisible(snapshot, missing), false);
  });

  it('says whether the lock is off, and whether the team is shown it', () => {
    assert.equal(isMissionUnlocked(snapshot, 'alpha' as MissionInstanceId), true);
    assert.equal(isMissionVisible(snapshot, 'alpha' as MissionInstanceId), true);
  });
});

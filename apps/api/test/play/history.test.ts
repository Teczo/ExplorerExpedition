/**
 * A mission's history, stored and read back (EXPD-020).
 *
 * A mission state is never a column. It is replayed from the stored history
 * on every request, by the engine's own `replayMissionTransitions`, so these
 * tests hold two things to account: a line read back is the line that was
 * written, and a history the rules could not have produced is not played on.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_MISSION_STATE_POLICY } from '@explorer/engine';
import type { MissionTransition } from '@explorer/shared-types';

import {
  MissionHistoryError,
  missionTransitionColumns,
  rebuildMissions,
  toMissionTransition,
} from '../../src/play/mission-log.ts';
import type { MissionTransitionRow } from '../../src/repositories/rows.ts';
import { ASHA, ORG_A, RUN_A, TEAM_RED, harness, phone, teamRows } from './support.ts';

/** A stored row, as the columns would come back from the driver. */
function rowOf(transition: MissionTransition, sequence: number, key = 'gate'): MissionTransitionRow {
  const columns = missionTransitionColumns(transition);
  return {
    id: `row-${String(sequence)}`,
    organisation_id: ORG_A,
    expedition_session_id: RUN_A,
    team_id: TEAM_RED,
    mission_instance_key: key,
    mission_attempt_id: null,
    sequence,
    ...(columns as Omit<MissionTransitionRow, 'id' | 'organisation_id' | 'expedition_session_id' | 'team_id' | 'mission_instance_key' | 'mission_attempt_id' | 'sequence'>),
  };
}

const UNLOCK: MissionTransition = {
  from: 'locked',
  to: 'available',
  trigger: 'unlock',
  actor: 'engine',
  at: '2026-03-03T12:00:00.000Z',
  attemptNumber: 0,
};

const START: MissionTransition = {
  from: 'available',
  to: 'in-progress',
  trigger: 'start',
  actor: 'team',
  at: '2026-03-03T12:01:00.000Z',
  attemptNumber: 1,
  reason: 'Off we go.',
  detail: { by: 'phone' },
};

describe('a line read back is the line that was written', () => {
  test('every field, present or absent', () => {
    assert.deepEqual(toMissionTransition(rowOf(UNLOCK, 1)), UNLOCK);
    assert.deepEqual(toMissionTransition(rowOf(START, 2)), START);
  });

  test('an empty detail and no detail are the same line', () => {
    assert.deepEqual(toMissionTransition(rowOf({ ...UNLOCK, detail: {} }, 1)), UNLOCK);
  });

  test('a history rebuilds into the mission it left', () => {
    const missions = rebuildMissions(
      TEAM_RED,
      [rowOf(START, 2), rowOf(UNLOCK, 1)],
      () => DEFAULT_MISSION_STATE_POLICY,
    );
    const gate = missions.get('gate' as never);
    assert.equal(gate?.state, 'in-progress');
    assert.equal(gate?.attemptsUsed, 1);
    assert.equal(gate?.log.length, 2);
  });
});

describe('a history the rules could not have produced', () => {
  test('is caught when it is rebuilt', () => {
    // Straight from locked to in-progress: nobody unlocked it.
    const skipped = { ...START, from: 'locked' as const };
    assert.throws(
      () => rebuildMissions(TEAM_RED, [rowOf(skipped, 1)], () => DEFAULT_MISSION_STATE_POLICY),
      MissionHistoryError,
    );
  });

  test('is not played on, and nothing is written', async () => {
    const h = await harness();
    try {
      h.db.seed('mission_transition', {
        ...rowOf({ ...START, from: 'locked' }, 1),
        id: 'a0000000-0000-4000-8000-00000000f00d',
        occurred_at: new Date(START.at),
      });
      const answer = await h.submit(phone(ASHA), 'gate', { payload: { code: 'OTTER' } });

      assert.equal(answer.status, 500);
      assert.equal(teamRows(h, 'mission_transition', TEAM_RED).length, 1);
      assert.equal(h.rows('submission').length, 0);
    } finally {
      await h.close();
    }
  });
});

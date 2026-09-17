/**
 * That a stored line is the line that was sealed.
 *
 * The whole record rests on this and nothing else does the job. The seal on a
 * line is taken over the engine's event, so if writing that event into columns
 * and reading it back gives something even slightly different — a `detail` of
 * `{}` where there was none, a `note` of `''` where there was null, a time in
 * another offset — then every stored line fails its own check and the record
 * proves nothing.
 *
 * So each test here takes an event with an awkward field in it, puts it
 * through the columns, and checks two things: that what comes back is the same
 * event, and that sealing what comes back gives the same seal.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { entryDigest } from '@explorer/engine';
import {
  GENESIS_HASH,
  toId,
  type HintId,
  type MissionInstanceId,
  type NodeId,
  type ProgressionEvent,
  type ScoreEvent,
  type ScoringRuleId,
} from '@explorer/shared-types';

import type { ProgressionEventRow, ScoreEventRow } from '../../src/repositories/rows.ts';
import {
  normaliseProgressionEvent,
  normaliseScoreEvent,
  progressionEventColumns,
  scoreEventColumns,
  toProgressionEvent,
  toScoreEvent,
} from '../../src/stream/rows.ts';

const alpha = toId<'missionInstance'>('alpha') as MissionInstanceId;
const firstHint = toId<'hint'>('hint-one') as HintId;
const quick = toId<'scoringRule'>('quick') as ScoringRuleId;
const start = toId<'node'>('start') as NodeId;

/** Writes a score event into columns and reads it straight back. */
function throughColumns(event: ScoreEvent): ScoreEvent {
  const columns = scoreEventColumns(event) as Record<string, never>;
  return toScoreEvent({
    ...columns,
    id: 'row',
    organisation_id: 'org',
    expedition_session_id: 'session',
    team_id: 'team',
    participant_id: null,
    mission_instance_id: null,
    mission_attempt_id: null,
    submission_id: null,
    hint_id: null,
    created_by: null,
    stream_sequence: '1',
    previous_hash: GENESIS_HASH,
    hash: GENESIS_HASH,
    created_at: new Date(0),
  } as unknown as ScoreEventRow);
}

/** The same, for a progression event. */
function progressionThroughColumns(event: ProgressionEvent): ProgressionEvent {
  const columns = progressionEventColumns(event) as Record<string, never>;
  return toProgressionEvent({
    ...columns,
    id: 'row',
    organisation_id: 'org',
    expedition_session_id: 'session',
    team_id: 'team',
    stream_sequence: '1',
    previous_hash: GENESIS_HASH,
    hash: GENESIS_HASH,
    created_at: new Date(0),
  } as unknown as ProgressionEventRow);
}

/** That a line still seals to what it sealed to before it was stored. */
function sealsTheSame(before: ScoreEvent, after: ScoreEvent): void {
  assert.equal(
    entryDigest({ kind: 'score', event: after }, 1, GENESIS_HASH),
    entryDigest({ kind: 'score', event: normaliseScoreEvent(before) }, 1, GENESIS_HASH),
  );
}

describe('a score line through the columns and back', () => {
  it('keeps the plainest line there is', () => {
    const event: ScoreEvent = {
      reason: 'mission-complete',
      points: 100,
      at: '2026-05-12T10:00:30.000Z',
    };
    assert.deepEqual(throughColumns(event), event);
    sealsTheSame(event, throughColumns(event));
  });

  it('keeps every field a line can carry', () => {
    const event: ScoreEvent = {
      reason: 'speed-bonus',
      points: 25,
      at: '2026-05-12T10:00:30.000Z',
      missionInstanceId: alpha,
      scoringRuleId: quick,
      attemptNumber: 2,
      note: 'Beat the ten minutes.',
      detail: { seconds: 412 },
    };
    assert.deepEqual(throughColumns(event), event);
    sealsTheSame(event, throughColumns(event));
  });

  it('keeps what a cap trimmed, which 0001 had nowhere to put', () => {
    const event: ScoreEvent = {
      reason: 'streak-bonus',
      points: 10,
      at: '2026-05-12T10:00:30.000Z',
      missionInstanceId: alpha,
      limit: { kind: 'mission-cap', wouldHaveBeen: 40 },
    };
    assert.deepEqual(throughColumns(event), event);
    sealsTheSame(event, throughColumns(event));
  });

  it('keeps a hint by the id the document uses, not a row id', () => {
    const event: ScoreEvent = {
      reason: 'hint-penalty',
      points: -20,
      at: '2026-05-12T10:00:30.000Z',
      missionInstanceId: alpha,
      hintId: firstHint,
    };
    assert.equal(throughColumns(event).hintId, firstHint);
    sealsTheSame(event, throughColumns(event));
  });

  it('keeps a negative figure negative', () => {
    const event: ScoreEvent = {
      reason: 'manual-adjustment',
      points: -50,
      at: '2026-05-12T10:00:30.000Z',
      note: 'Took the shortcut across the car park.',
    };
    assert.deepEqual(throughColumns(event), event);
  });

  it('does not invent a field the line never had', () => {
    const event: ScoreEvent = {
      reason: 'mission-complete',
      points: 100,
      at: '2026-05-12T10:00:30.000Z',
    };
    const read = throughColumns(event);
    for (const field of ['missionInstanceId', 'hintId', 'note', 'limit', 'detail']) {
      assert.equal(field in read, false, `${field} should not be on the line`);
    }
  });

  it('keeps an empty note, which is not the same as no note', () => {
    const event: ScoreEvent = {
      reason: 'manual-adjustment',
      points: 5,
      at: '2026-05-12T10:00:30.000Z',
      note: '',
    };
    assert.equal(throughColumns(event).note, '');
  });

  it('reads a time back as the same instant, written in UTC', () => {
    const event: ScoreEvent = {
      reason: 'mission-complete',
      points: 100,
      // The same instant, said in another offset. The schema stores one way.
      at: '2026-05-12T12:00:30.000+02:00',
    };
    assert.equal(throughColumns(event).at, '2026-05-12T10:00:30.000Z');
  });

  it('treats a detail with nothing in it as no detail, before it is sealed', () => {
    // The column is NOT NULL DEFAULT '{}', so it cannot tell the two apart.
    // Normalising on the way in is what keeps the seal reproducible.
    const event: ScoreEvent = {
      reason: 'mission-complete',
      points: 100,
      at: '2026-05-12T10:00:30.000Z',
      detail: {},
    };
    assert.equal('detail' in normaliseScoreEvent(event), false);
    assert.equal('detail' in throughColumns(event), false);
    sealsTheSame(event, throughColumns(event));
  });

  it('keeps a detail that has something in it', () => {
    const event: ScoreEvent = {
      reason: 'mission-complete',
      points: 100,
      at: '2026-05-12T10:00:30.000Z',
      detail: { nested: { kept: true }, list: [1, 2] },
    };
    assert.deepEqual(throughColumns(event).detail, event.detail);
    sealsTheSame(event, throughColumns(event));
  });
});

describe('a progression line through the columns and back', () => {
  it('keeps a stop the team reached', () => {
    const event: ProgressionEvent = {
      reason: 'node-reached',
      at: '2026-05-12T10:00:00.000Z',
      nodeId: start,
    };
    assert.deepEqual(progressionThroughColumns(event), event);
  });

  it('keeps a mission and the stop that holds it', () => {
    const event: ProgressionEvent = {
      reason: 'mission-unlocked',
      at: '2026-05-12T10:00:00.000Z',
      nodeId: start,
      missionInstanceId: alpha,
      note: 'The bridge cleared.',
      detail: { because: 'edge-two' },
    };
    assert.deepEqual(progressionThroughColumns(event), event);
  });

  it('does not invent a field the line never had', () => {
    const event: ProgressionEvent = {
      reason: 'expedition-finished',
      at: '2026-05-12T11:00:00.000Z',
    };
    const read = progressionThroughColumns(event);
    assert.deepEqual(read, event);
    assert.equal('nodeId' in read, false);
  });

  it('treats a detail with nothing in it as no detail', () => {
    const event: ProgressionEvent = {
      reason: 'node-cleared',
      at: '2026-05-12T10:00:00.000Z',
      nodeId: start,
      detail: {},
    };
    assert.equal('detail' in normaliseProgressionEvent(event), false);
    assert.equal('detail' in progressionThroughColumns(event), false);
  });
});

/**
 * The words a stream is said in.
 *
 * The rules that seal, check and replay one are tested in the engine. What is
 * tested here is the vocabulary every app reads: that the five progression
 * reasons are the five the database column holds, that the opening seal is
 * the shape a seal is, and that the small readers on a line agree with the
 * line they are reading.
 *
 * The first of those matters for the reason the scoring vocabulary gives: a
 * progression event crosses the boundary. The engine mints one, the API
 * writes it into `progression_event`, and that column is a PostgreSQL enum. A
 * reason the engine can say and the column cannot hold is a run that fails at
 * the moment a team walks through a door.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  GENESIS_HASH,
  PROGRESSION_EVENT_REASONS,
  STREAM_DEFECT_CODES,
  STREAM_EVENT_KINDS,
  isProgressionEntry,
  isProgressionEventReason,
  isScoreEntry,
  isStreamDefectCode,
  streamEventAt,
  streamHeadHash,
  type ProgressionStreamEntry,
  type ScoreStreamEntry,
} from '../../src/index.ts';

/**
 * `progression_event_reason` from migration 0004, value for value and in
 * order.
 *
 * Written out rather than read off the SQL file, for the reason the scoring
 * vocabulary test gives: this package does not read files, and a test that
 * parsed a migration would be testing the parser. Changing either list
 * without the other is what this catches.
 */
const COLUMN_VALUES = [
  'node-reached',
  'node-cleared',
  'mission-unlocked',
  'mission-revealed',
  'expedition-finished',
];

describe('the reasons a team moved through the graph', () => {
  it('is the enum the column holds, value for value and in order', () => {
    assert.deepEqual([...PROGRESSION_EVENT_REASONS], COLUMN_VALUES);
  });

  it('has no duplicates', () => {
    assert.equal(new Set(PROGRESSION_EVENT_REASONS).size, PROGRESSION_EVENT_REASONS.length);
  });

  it('recognises every one of its own words', () => {
    for (const reason of PROGRESSION_EVENT_REASONS) {
      assert.equal(isProgressionEventReason(reason), true);
    }
  });

  it('recognises nothing else', () => {
    for (const value of ['node-unreached', 'mission-locked', '', null, 7, undefined]) {
      assert.equal(isProgressionEventReason(value), false);
    }
  });
});

describe('the two kinds of line', () => {
  it('has one for each half of the record', () => {
    assert.deepEqual([...STREAM_EVENT_KINDS], ['score', 'progression']);
  });

  const score: ScoreStreamEntry = {
    kind: 'score',
    event: { reason: 'mission-complete', points: 100, at: '2026-05-12T10:00:00.000Z' },
    sequence: 1,
    previousHash: GENESIS_HASH,
    hash: 'a'.repeat(64),
  };

  const progression: ProgressionStreamEntry = {
    kind: 'progression',
    event: { reason: 'node-reached', at: '2026-05-12T10:01:00.000Z' },
    sequence: 2,
    previousHash: 'a'.repeat(64),
    hash: 'b'.repeat(64),
  };

  it('tells one from the other', () => {
    assert.equal(isScoreEntry(score), true);
    assert.equal(isProgressionEntry(score), false);
    assert.equal(isProgressionEntry(progression), true);
    assert.equal(isScoreEntry(progression), false);
  });

  it('reads the time off either without unwrapping it first', () => {
    assert.equal(streamEventAt(score), '2026-05-12T10:00:00.000Z');
    assert.equal(streamEventAt(progression), '2026-05-12T10:01:00.000Z');
  });

  it('calls the seal on the last line the head of the stream', () => {
    assert.equal(streamHeadHash([score, progression]), progression.hash);
  });

  it('calls an empty stream the opening seal', () => {
    assert.equal(streamHeadHash([]), GENESIS_HASH);
  });
});

describe('the opening seal', () => {
  it('is the shape a seal is, so one rule checks every line', () => {
    assert.match(GENESIS_HASH, /^[0-9a-f]{64}$/);
  });

  it('is the value migration 0004 writes on a first line', () => {
    assert.equal(GENESIS_HASH, '0'.repeat(64));
  });
});

describe('what can be wrong with a stream', () => {
  it('names the four, in the order they are documented', () => {
    assert.deepEqual([...STREAM_DEFECT_CODES], [
      'out-of-order',
      'broken-chain',
      'edited',
      'total-disagrees',
    ]);
  });

  it('recognises its own words and nothing else', () => {
    for (const code of STREAM_DEFECT_CODES) {
      assert.equal(isStreamDefectCode(code), true);
    }
    for (const value of ['invalid', '', null, 3]) {
      assert.equal(isStreamDefectCode(value), false);
    }
  });
});

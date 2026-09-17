/**
 * The words a score change is said in.
 *
 * The rules that produce one are tested in the engine. What is tested here is
 * the vocabulary every app reads: that the ten reasons are the ten the
 * database column already holds, that the seven scoring rule types each have
 * a reason named after them, and that nothing has quietly been added to
 * either list.
 *
 * The reason the first of those matters is that a score event crosses the
 * boundary. The engine mints one, the API writes it into `score_event`, and
 * that column is a PostgreSQL enum. A reason the engine can say and the
 * column cannot hold is a run that fails at the moment a team scores.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SCORE_EVENT_REASONS,
  SCORE_REFUSAL_CODES,
  SCORING_RULE_TYPES,
  isScoreEventReason,
  isScoreRefusalCode,
} from '../../src/index.ts';

/**
 * `score_event_reason` from migration 0001, value for value and in order.
 *
 * Written out rather than read off the SQL file on purpose: this package does
 * not read files, and a test that parsed a migration would be testing the
 * parser. Changing either list without the other is what this catches.
 */
const COLUMN_VALUES = [
  'mission-complete',
  'partial-credit',
  'speed-bonus',
  'first-to-complete-bonus',
  'streak-bonus',
  'completion-bonus',
  'hint-penalty',
  'attempt-penalty',
  'late-penalty',
  'manual-adjustment',
];

describe('why a score moved', () => {
  it('is the ten the database column holds, in the same order', () => {
    assert.deepEqual([...SCORE_EVENT_REASONS], COLUMN_VALUES);
  });

  it('holds no word twice', () => {
    assert.equal(new Set(SCORE_EVENT_REASONS).size, SCORE_EVENT_REASONS.length);
  });

  it('names every scoring rule type', () => {
    for (const type of SCORING_RULE_TYPES) {
      assert.ok(
        (SCORE_EVENT_REASONS as readonly string[]).includes(type),
        `a "${type}" rule can fire and has no reason to write down`,
      );
    }
  });

  it('adds exactly three reasons no rule causes', () => {
    const notARule = SCORE_EVENT_REASONS.filter(
      (reason) => !(SCORING_RULE_TYPES as readonly string[]).includes(reason),
    );
    assert.deepEqual(notARule, [
      'mission-complete',
      'partial-credit',
      'manual-adjustment',
    ]);
  });

  it('refuses a word that is not one of them', () => {
    for (const reason of SCORE_EVENT_REASONS) {
      assert.equal(isScoreEventReason(reason), true);
    }
    assert.equal(isScoreEventReason('bonus'), false);
    assert.equal(isScoreEventReason('MISSION-COMPLETE'), false);
    assert.equal(isScoreEventReason(undefined), false);
    assert.equal(isScoreEventReason(7), false);
  });
});

describe('a score change the rules will not make', () => {
  it('is the three the engine can answer with', () => {
    assert.deepEqual(
      [...SCORE_REFUSAL_CODES],
      ['not-decided', 'already-scored', 'hint-already-spent'],
    );
  });

  it('refuses a code that is not one of them', () => {
    for (const code of SCORE_REFUSAL_CODES) {
      assert.equal(isScoreRefusalCode(code), true);
    }
    assert.equal(isScoreRefusalCode('too-late'), false);
    assert.equal(isScoreRefusalCode(null), false);
  });
});

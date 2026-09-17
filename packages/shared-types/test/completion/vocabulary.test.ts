/**
 * The words a verdict is said in.
 *
 * The rules that produce one are tested in the engine. What is tested here is
 * the vocabulary every app reads: that the four outcomes, the five methods
 * and the three review settings the ticket names are what is there, that
 * nothing has quietly been added, and that the guards anything can call to
 * check an unknown string really do refuse one.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COMPLETION_METHODS,
  COMPLETION_OUTCOMES,
  COMPLETION_REFUSAL_CODES,
  COMPLETION_REVIEWS,
  isCompletionMethod,
  isCompletionOutcome,
  isCompletionRefusalCode,
  isCompletionReview,
} from '../../src/index.ts';

describe('what checking the work concluded', () => {
  it('is the four the ticket names', () => {
    assert.deepEqual(
      [...COMPLETION_OUTCOMES],
      ['correct', 'incorrect', 'needs-review', 'expired'],
    );
  });

  it('holds no word twice', () => {
    assert.equal(new Set(COMPLETION_OUTCOMES).size, COMPLETION_OUTCOMES.length);
  });

  it('opens with the three a mission type may answer', () => {
    // `MissionOutcome` in the engine is the first three of these, and the
    // engine has a test that keeps it that way. This is the other side of it.
    assert.deepEqual(COMPLETION_OUTCOMES.slice(0, 3), [
      'correct',
      'incorrect',
      'needs-review',
    ]);
  });

  it('recognises its own words and nothing else', () => {
    for (const outcome of COMPLETION_OUTCOMES) {
      assert.equal(isCompletionOutcome(outcome), true);
    }
    for (const other of ['right', 'wrong', 'Correct', '', null, 7, {}]) {
      assert.equal(isCompletionOutcome(other), false);
    }
  });
});

describe('what reached that conclusion', () => {
  it('is the five the ticket names', () => {
    assert.deepEqual(
      [...COMPLETION_METHODS],
      ['behaviour', 'location', 'teacher', 'timer', 'referral'],
    );
  });

  it('names no mission type', () => {
    // A matched code and a right answer are both `behaviour`. If a mission
    // type key ever appears in this list, the engine has started to care
    // which kind of mission it is judging.
    for (const method of COMPLETION_METHODS) {
      assert.equal(method.includes('-'), false, `${method} reads like a type key`);
    }
  });

  it('recognises its own words and nothing else', () => {
    for (const method of COMPLETION_METHODS) {
      assert.equal(isCompletionMethod(method), true);
    }
    for (const other of ['engine', 'automatic', '', undefined, 3]) {
      assert.equal(isCompletionMethod(other), false);
    }
  });
});

describe('whether a person still has to look', () => {
  it('is the three the ticket names', () => {
    assert.deepEqual([...COMPLETION_REVIEWS], ['none', 'required', 'optional']);
  });

  it('recognises its own words and nothing else', () => {
    for (const review of COMPLETION_REVIEWS) {
      assert.equal(isCompletionReview(review), true);
    }
    for (const other of ['maybe', 'None', true, null]) {
      assert.equal(isCompletionReview(other), false);
    }
  });
});

describe('why work was not checked', () => {
  it('is the six the interface can answer', () => {
    assert.deepEqual(
      [...COMPLETION_REFUSAL_CODES],
      [
        'not-now',
        'unknown-mission-type',
        'invalid-submission',
        'wrong-place',
        'poor-accuracy',
        'not-yet-expired',
      ],
    );
  });

  it('holds no word twice', () => {
    assert.equal(
      new Set(COMPLETION_REFUSAL_CODES).size,
      COMPLETION_REFUSAL_CODES.length,
    );
  });

  it('recognises its own words and nothing else', () => {
    for (const code of COMPLETION_REFUSAL_CODES) {
      assert.equal(isCompletionRefusalCode(code), true);
    }
    for (const other of ['wrong-state', 'refused', '', 0]) {
      assert.equal(isCompletionRefusalCode(other), false);
    }
  });

  it('shares no word with the refusals the state machine makes', () => {
    // A refusal from the state machine arrives wrapped as `not-now` with the
    // original inside it, so the two lists never have to be told apart by a
    // caller that holds one code and does not know where it came from.
    const stateCodes = [
      'wrong-state',
      'terminal-state',
      'no-attempts-left',
      'skip-not-allowed',
      'unknown-trigger',
    ];
    for (const code of COMPLETION_REFUSAL_CODES) {
      assert.equal(stateCodes.includes(code), false);
    }
  });
});

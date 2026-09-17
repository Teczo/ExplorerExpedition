/**
 * Where the four settings the interface reads come from.
 *
 * Three are on the mission and one is on the expedition, and the point of
 * gathering them is that there is one place to look when they disagree. What
 * is tested is that each one is read off the document that holds it, that the
 * expedition's blanket rule only ever adds review, and that a caller who
 * passes nothing gets the plainest mission there is rather than one nobody
 * can finish.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { MissionOutcome } from '../../src/mission-types/behaviour.ts';
import type { CompletionOutcome } from '@explorer/shared-types';
import { COMPLETION_OUTCOMES } from '@explorer/shared-types';
import {
  DEFAULT_MISSION_COMPLETION_POLICY,
  effectiveVerification,
  missionCompletionPolicyFor,
} from '../../src/completion/policy.ts';
import { missionOf, mustBeAt, rulesOf, square } from './support.ts';

describe('reading the policy off the documents', () => {
  it('takes how work is judged from the mission', () => {
    for (const mode of ['automatic', 'teacher', 'automatic-with-review'] as const) {
      const policy = missionCompletionPolicyFor(
        missionOf('code-match', { verification: mode }),
        rulesOf(false),
      );
      assert.equal(policy.verification, mode);
    }
  });

  it('takes the blanket review rule from the expedition', () => {
    assert.equal(
      missionCompletionPolicyFor(missionOf('code-match'), rulesOf(true)).requireReviewForAll,
      true,
    );
    assert.equal(
      missionCompletionPolicyFor(missionOf('code-match'), rulesOf(false)).requireReviewForAll,
      false,
    );
  });

  it('takes the time limit from the mission, and null when it has none', () => {
    assert.equal(
      missionCompletionPolicyFor(
        missionOf('code-match', { timeLimitSeconds: 300 }),
        rulesOf(false),
      ).timeLimitSeconds,
      300,
    );
    assert.equal(
      missionCompletionPolicyFor(missionOf('code-match'), rulesOf(false)).timeLimitSeconds,
      null,
    );
  });

  it('takes the place from the mission, and null when it may be done anywhere', () => {
    assert.deepEqual(
      missionCompletionPolicyFor(
        missionOf('code-match', { location: mustBeAt(square) }),
        rulesOf(false),
      ).location,
      mustBeAt(square),
    );
    assert.equal(
      missionCompletionPolicyFor(missionOf('code-match'), rulesOf(false)).location,
      null,
    );
  });
});

describe('how work is judged once the expedition has had its say', () => {
  it('is what the mission says, when the expedition says nothing', () => {
    for (const mode of ['automatic', 'teacher', 'automatic-with-review'] as const) {
      const policy = missionCompletionPolicyFor(
        missionOf('code-match', { verification: mode }),
        rulesOf(false),
      );
      assert.equal(effectiveVerification(policy), mode);
    }
  });

  it('is a teacher, whatever the mission says, when the expedition asks for one', () => {
    for (const mode of ['automatic', 'teacher', 'automatic-with-review'] as const) {
      const policy = missionCompletionPolicyFor(
        missionOf('code-match', { verification: mode }),
        rulesOf(true),
      );
      assert.equal(effectiveVerification(policy), 'teacher');
    }
  });

  it('only ever adds review, and never takes one away', () => {
    // There is no setting anywhere that turns off a review a mission asked
    // for. If one appeared, this is what would catch it.
    const asked = missionCompletionPolicyFor(
      missionOf('code-match', { verification: 'teacher' }),
      rulesOf(false),
    );
    assert.equal(effectiveVerification({ ...asked, requireReviewForAll: false }), 'teacher');
    assert.equal(effectiveVerification({ ...asked, requireReviewForAll: true }), 'teacher');
  });
});

describe('the policy a caller gets for passing none', () => {
  it('is the plainest mission there is', () => {
    assert.deepEqual(DEFAULT_MISSION_COMPLETION_POLICY, {
      verification: 'automatic',
      requireReviewForAll: false,
      timeLimitSeconds: null,
      location: null,
    });
  });
});

describe('the two lists of outcomes', () => {
  it('agree, so that a behaviour never answers a word nothing can show', () => {
    // `MissionOutcome` is the engine's, and a mission type returns one.
    // `CompletionOutcome` is what every app reads. The first has to fit
    // inside the second, and TypeScript is what checks it: this assignment
    // is the test, and the run below only keeps it honest at runtime too.
    const everyBehaviourOutcome: readonly MissionOutcome[] = [
      'correct',
      'incorrect',
      'needs-review',
    ];
    const widened: readonly CompletionOutcome[] = everyBehaviourOutcome;
    for (const outcome of widened) {
      assert.ok((COMPLETION_OUTCOMES as readonly string[]).includes(outcome));
    }
  });
});

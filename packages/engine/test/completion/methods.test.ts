/**
 * The six ways a mission is completed, one by one.
 *
 * This is the ticket's own list: a code matched, a photo handed in, a teacher
 * approved, an answer was right, a place was reached, a clock ran out. Each
 * one gets a test here, and each one has to come back through the same door
 * with the same shape of answer. That is the whole claim EXPD-011 makes, so
 * it is the test that would fail first if the claim stopped being true.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createMissionTypeRegistry } from '../../src/mission-types/index.ts';
import { completeMission } from '../../src/completion/complete.ts';
import { missionCompletionPolicyFor } from '../../src/completion/policy.ts';
import {
  at,
  byHand,
  codeMatch,
  evidence,
  missionOf,
  mustBeAt,
  openedMission,
  rulesOf,
} from './support.ts';

const registry = createMissionTypeRegistry([codeMatch, evidence, byHand]);

/** Inside the circle. */
const there = { latitude: 51.5081, longitude: -0.1281 };
/** A good four hundred metres away. */
const elsewhere = { latitude: 51.5045, longitude: -0.1275 };

describe('a scanned code that matched', () => {
  const mission = missionOf('code-match', { config: { wanted: 'EXPD-7742' } });

  it('completes the mission, and says the mission type decided', () => {
    const result = completeMission({
      kind: 'submission',
      registry,
      mission,
      progress: openedMission(mission.id),
      payload: { scanned: 'expd-7742' },
      at: at(30),
      completionPolicy: missionCompletionPolicyFor(mission, rulesOf(false)),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.equal(result.progress.state, 'complete');
    assert.deepEqual(
      { ...result.verdict },
      {
        outcome: 'correct',
        method: 'behaviour',
        trigger: 'accept',
        review: 'none',
        progress: 1,
        feedback: 'That is the one.',
      },
    );
  });

  it('writes the handing in and the verdict down as two lines', () => {
    const result = completeMission({
      kind: 'submission',
      registry,
      mission,
      progress: openedMission(mission.id),
      payload: { scanned: 'EXPD-7742' },
      at: at(30),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.deepEqual(
      result.transitions.map((line) => [line.from, line.trigger, line.to, line.actor]),
      [
        ['in-progress', 'submit', 'submitted', 'team'],
        ['submitted', 'accept', 'complete', 'engine'],
      ],
    );
    assert.deepEqual(result.progress.log.slice(-2), [...result.transitions]);
  });
});

describe('an answer that was wrong', () => {
  const mission = missionOf('code-match', { config: { wanted: 'EXPD-7742' } });

  it('hands the mission back, and is not a refusal', () => {
    const result = completeMission({
      kind: 'submission',
      registry,
      mission,
      progress: openedMission(mission.id),
      payload: { scanned: 'EXPD-0000' },
      at: at(30),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.equal(result.verdict.outcome, 'incorrect');
    assert.equal(result.verdict.trigger, 'reject');
    assert.equal(result.progress.state, 'available');
    assert.equal(result.progress.attemptsUsed, 1);
  });
});

describe('a photo handed in', () => {
  const mission = missionOf('evidence');

  it('goes to a person, and says a person still has to look', () => {
    const result = completeMission({
      kind: 'submission',
      registry,
      mission,
      progress: openedMission(mission.id),
      payload: { mediaId: 'media-91' },
      at: at(30),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.equal(result.verdict.outcome, 'needs-review');
    assert.equal(result.verdict.method, 'behaviour');
    assert.equal(result.verdict.trigger, 'refer');
    assert.equal(result.verdict.review, 'required');
    assert.equal(result.progress.state, 'awaiting-verification');
    assert.deepEqual(result.verdict.detail, { mediaId: 'media-91' });
  });
});

describe('a teacher approving work', () => {
  const mission = missionOf('evidence');

  /** A mission that is sitting in the review queue. */
  function waiting() {
    const referred = completeMission({
      kind: 'submission',
      registry,
      mission,
      progress: openedMission(mission.id),
      payload: { mediaId: 'media-91' },
      at: at(30),
    });
    assert.equal(referred.applied, true);
    return referred.progress;
  }

  it('completes the mission, and the person is the actor', () => {
    const result = completeMission({
      kind: 'review',
      progress: waiting(),
      decision: 'approve',
      reason: 'Everybody is in the picture.',
      at: at(600),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.equal(result.progress.state, 'complete');
    assert.equal(result.verdict.outcome, 'correct');
    assert.equal(result.verdict.method, 'teacher');
    assert.equal(result.verdict.trigger, 'verify');
    assert.equal(result.verdict.review, 'none');
    assert.equal(result.transitions.length, 1);
    assert.equal(result.transitions[0]?.actor, 'teacher');
    assert.equal(result.transitions[0]?.reason, 'Everybody is in the picture.');
  });

  it('hands it back when the teacher says no', () => {
    const result = completeMission({
      kind: 'review',
      progress: waiting(),
      decision: 'reject',
      reason: 'Only two of you are in it.',
      at: at(600),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.equal(result.progress.state, 'available');
    assert.equal(result.verdict.trigger, 'overrule');
    assert.equal(result.verdict.outcome, 'incorrect');
  });

  it('ends the mission when the team had no try left', () => {
    const policy = { maxAttempts: 1, allowSkip: false };
    const referred = completeMission({
      kind: 'submission',
      registry,
      mission,
      progress: openedMission(mission.id, policy),
      payload: { mediaId: 'media-91' },
      at: at(30),
      statePolicy: policy,
    });
    assert.equal(referred.applied, true);

    const result = completeMission({
      kind: 'review',
      progress: referred.progress,
      decision: 'reject',
      at: at(600),
      statePolicy: policy,
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.equal(result.progress.state, 'failed');
  });
});

describe('a mission an author marked for a teacher', () => {
  const mission = missionOf('code-match', {
    config: { wanted: 'EXPD-7742' },
    verification: 'teacher',
  });

  it('never runs the mission type, even when it could have decided', () => {
    const result = completeMission({
      kind: 'submission',
      registry,
      mission,
      progress: openedMission(mission.id),
      // The right answer. It still goes to a person, because the author said so.
      payload: { scanned: 'EXPD-7742' },
      at: at(30),
      completionPolicy: missionCompletionPolicyFor(mission, rulesOf(false)),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.equal(result.verdict.method, 'referral');
    assert.equal(result.progress.state, 'awaiting-verification');
    assert.equal(result.verdict.feedback, undefined);
    assert.match(result.verdict.reason ?? '', /marked for a teacher/);
  });
});

describe('an expedition that has a teacher check everything', () => {
  const mission = missionOf('code-match', { config: { wanted: 'EXPD-7742' } });

  it('overrides what the mission itself says', () => {
    const result = completeMission({
      kind: 'submission',
      registry,
      mission,
      progress: openedMission(mission.id),
      payload: { scanned: 'EXPD-7742' },
      at: at(30),
      completionPolicy: missionCompletionPolicyFor(mission, rulesOf(true)),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.equal(result.verdict.review, 'required');
    assert.match(result.verdict.reason ?? '', /every submission/);
  });
});

describe('a mission the engine decides and a teacher may still see', () => {
  const mission = missionOf('code-match', {
    config: { wanted: 'EXPD-7742' },
    verification: 'automatic-with-review',
  });

  it('answers the team now and puts the work in the queue anyway', () => {
    const result = completeMission({
      kind: 'submission',
      registry,
      mission,
      progress: openedMission(mission.id),
      payload: { scanned: 'EXPD-7742' },
      at: at(30),
      completionPolicy: missionCompletionPolicyFor(mission, rulesOf(false)),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.equal(result.progress.state, 'complete');
    assert.equal(result.verdict.review, 'optional');
  });
});

describe('a place reached', () => {
  const mission = missionOf('by-hand', { location: mustBeAt() });

  it('completes a mission whose type has no code of its own', () => {
    const result = completeMission({
      kind: 'submission',
      registry,
      mission,
      progress: openedMission(mission.id),
      payload: { note: 'We are here.' },
      position: there,
      at: at(30),
      completionPolicy: missionCompletionPolicyFor(mission, rulesOf(false)),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.equal(result.verdict.outcome, 'correct');
    assert.equal(result.verdict.method, 'location');
    assert.equal(result.progress.state, 'complete');
  });

  it('refuses work from the wrong place, and spends nothing', () => {
    const progress = openedMission(mission.id);
    const result = completeMission({
      kind: 'submission',
      registry,
      mission,
      progress,
      payload: { note: 'We are here, honest.' },
      position: elsewhere,
      at: at(30),
      completionPolicy: missionCompletionPolicyFor(mission, rulesOf(false)),
    });

    assert.equal(result.applied, false);
    if (result.applied) {
      return;
    }
    assert.equal(result.refusal.code, 'wrong-place');
    assert.ok((result.refusal.metresAway ?? 0) > 300);
    // Nothing moved and nothing was written down.
    assert.deepEqual(result.progress, progress);
  });

  it('still lets the mission type decide when there is one', () => {
    const scanning = missionOf('code-match', {
      config: { wanted: 'EXPD-7742' },
      location: mustBeAt(),
    });
    const result = completeMission({
      kind: 'submission',
      registry,
      mission: scanning,
      progress: openedMission(scanning.id),
      payload: { scanned: 'EXPD-7742' },
      position: there,
      at: at(30),
      completionPolicy: missionCompletionPolicyFor(scanning, rulesOf(false)),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    // Being there was the gate. The code is what was judged.
    assert.equal(result.verdict.method, 'behaviour');
  });

  it('sends a mission with no place and no code to a person', () => {
    const anywhere = missionOf('by-hand');
    const result = completeMission({
      kind: 'submission',
      registry,
      mission: anywhere,
      progress: openedMission(anywhere.id),
      payload: { note: 'Done.' },
      at: at(30),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.equal(result.verdict.method, 'referral');
    assert.equal(result.progress.state, 'awaiting-verification');
    assert.match(result.verdict.reason ?? '', /no code to judge with/);
  });
});

describe('a clock that ran out', () => {
  const mission = missionOf('code-match', {
    config: { wanted: 'EXPD-7742' },
    timeLimitSeconds: 300,
  });
  const policy = missionCompletionPolicyFor(mission, rulesOf(false));

  it('ends the mission once the time is up', () => {
    const result = completeMission({
      kind: 'expiry',
      progress: openedMission(mission.id),
      at: at(300),
      completionPolicy: policy,
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.equal(result.progress.state, 'failed');
    assert.equal(result.verdict.outcome, 'expired');
    assert.equal(result.verdict.method, 'timer');
    assert.equal(result.verdict.trigger, 'expire');
    assert.equal(result.transitions[0]?.actor, 'engine');
  });

  it('refuses a timer that went off early, and says when it should', () => {
    const progress = openedMission(mission.id);
    const result = completeMission({
      kind: 'expiry',
      progress,
      at: at(299),
      completionPolicy: policy,
    });

    assert.equal(result.applied, false);
    if (result.applied) {
      return;
    }
    assert.equal(result.refusal.code, 'not-yet-expired');
    assert.equal(result.refusal.expiresAt, at(300));
    assert.deepEqual(result.progress, progress);
  });

  it('takes an untimed mission on trust', () => {
    const untimed = missionOf('code-match', { config: { wanted: 'EXPD-7742' } });
    const result = completeMission({
      kind: 'expiry',
      progress: openedMission(untimed.id),
      at: at(9999),
      reason: 'The expedition ended.',
      completionPolicy: missionCompletionPolicyFor(untimed, rulesOf(false)),
    });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.equal(result.progress.state, 'failed');
    assert.equal(result.verdict.reason, 'The expedition ended.');
  });
});

describe('every one of the six', () => {
  it('comes back as a verdict whose trigger is the one that was applied', () => {
    // Whatever went in, the verdict names the trigger the state machine was
    // given. Nothing downstream has to work that out for itself, which is
    // what stops two places from disagreeing about it.
    const mission = missionOf('code-match', { config: { wanted: 'EXPD-7742' } });
    const results = [
      completeMission({
        kind: 'submission',
        registry,
        mission,
        progress: openedMission(mission.id),
        payload: { scanned: 'EXPD-7742' },
        at: at(30),
      }),
      completeMission({
        kind: 'submission',
        registry,
        mission,
        progress: openedMission(mission.id),
        payload: { scanned: 'nope' },
        at: at(30),
      }),
      completeMission({
        kind: 'expiry',
        progress: openedMission(mission.id),
        at: at(30),
      }),
    ];

    for (const result of results) {
      assert.equal(result.applied, true);
      if (!result.applied) {
        continue;
      }
      const last = result.transitions.at(-1);
      assert.equal(last?.trigger, result.verdict.trigger);
      assert.equal(last?.to, result.progress.state);
    }
  });
});

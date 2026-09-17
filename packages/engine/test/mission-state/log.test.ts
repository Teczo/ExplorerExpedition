/**
 * The history, and reading it back.
 *
 * "All transitions are explicit and logged" is only worth something if the
 * log is complete and if somebody can check it. So: every change writes one
 * line, a line says everything about the change, and replaying the lines
 * either lands on the state that was stored or names the line it disagrees
 * with.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  toId,
  type MissionInstanceId,
  type MissionProgress,
  type MissionTransition,
} from '@explorer/shared-types';

import {
  createMissionProgress,
  replayMissionTransitions,
  requireMissionTransition,
  type MissionStatePolicy,
} from '../../src/mission-state/index.ts';

const MISSION: MissionInstanceId = toId('bird-count-1');
const POLICY: MissionStatePolicy = { maxAttempts: 2, allowSkip: true };

/** A team that gets it wrong, gets referred, and is signed off by a teacher. */
function played(): MissionProgress {
  const script = [
    { trigger: 'unlock', actor: 'engine', at: '2026-09-17T09:00:00.000Z' },
    { trigger: 'start', actor: 'team', at: '2026-09-17T09:05:00.000Z' },
    { trigger: 'submit', actor: 'team', at: '2026-09-17T09:07:00.000Z' },
    {
      trigger: 'reject',
      actor: 'engine',
      at: '2026-09-17T09:07:01.000Z',
      reason: 'The count was outside the tolerance.',
    },
    { trigger: 'start', actor: 'team', at: '2026-09-17T09:10:00.000Z' },
    { trigger: 'submit', actor: 'team', at: '2026-09-17T09:12:00.000Z' },
    { trigger: 'refer', actor: 'engine', at: '2026-09-17T09:12:01.000Z' },
    {
      trigger: 'verify',
      actor: 'teacher',
      at: '2026-09-17T09:30:00.000Z',
      reason: 'Photo shows the right hide.',
      detail: { reviewedBy: 'staff-4' },
    },
  ] as const;

  let progress = createMissionProgress(MISSION);
  for (const step of script) {
    progress = requireMissionTransition(progress, step, POLICY);
  }
  return progress;
}

describe('what the history holds', () => {
  const progress = played();

  it('has one line for every change and not one more', () => {
    assert.equal(progress.log.length, 8);
    assert.equal(progress.state, 'complete');
  });

  it('reads as an unbroken chain, each line starting where the last ended', () => {
    let state = 'locked';
    for (const entry of progress.log) {
      assert.equal(entry.from, state, entry.trigger);
      state = entry.to;
    }
    assert.equal(state, progress.state);
  });

  it('says what happened, who did it and when, on every line', () => {
    for (const entry of progress.log) {
      assert.ok(entry.trigger.length > 0);
      assert.ok(['team', 'engine', 'teacher'].includes(entry.actor));
      assert.ok(entry.at.endsWith('Z'));
      assert.ok(Number.isInteger(entry.attemptNumber));
    }
  });

  it('keeps a reason and a detail exactly as they were given', () => {
    const verified = progress.log.at(-1);
    assert.equal(verified?.reason, 'Photo shows the right hide.');
    assert.deepEqual(verified?.detail, { reviewedBy: 'staff-4' });
  });

  it('leaves a reason out rather than inventing one', () => {
    const unlocked = progress.log[0];
    assert.equal(unlocked?.trigger, 'unlock');
    assert.equal('reason' in (unlocked ?? {}), false);
    assert.equal('detail' in (unlocked ?? {}), false);
  });
});

describe('replaying a history', () => {
  const progress = played();

  it('lands exactly where the mission was left', () => {
    const replayed = replayMissionTransitions(
      createMissionProgress(MISSION),
      progress.log,
      POLICY,
    );
    assert.equal(replayed.consistent, true);
    assert.equal(replayed.consistent && replayed.progress.state, 'complete');
    assert.equal(replayed.consistent && replayed.progress.attemptsUsed, 2);
    assert.deepEqual(replayed.consistent && replayed.progress.log, progress.log);
  });

  it('lands nowhere on an empty history', () => {
    const fresh = createMissionProgress(MISSION);
    const replayed = replayMissionTransitions(fresh, [], POLICY);
    assert.equal(replayed.consistent, true);
    assert.deepEqual(replayed.consistent && replayed.progress, fresh);
  });

  it('names the line whose starting state is not where the mission was', () => {
    const tampered: MissionTransition[] = [...progress.log];
    const third = tampered[2];
    assert.ok(third !== undefined);
    tampered[2] = { ...third, from: 'available' };

    const replayed = replayMissionTransitions(
      createMissionProgress(MISSION),
      tampered,
      POLICY,
    );
    assert.equal(replayed.consistent, false);
    assert.equal(replayed.consistent === false && replayed.index, 2);
    assert.ok(replayed.consistent === false && replayed.message.includes('in-progress'));
  });

  it('names the line the rules would have refused', () => {
    const tampered: MissionTransition[] = [...progress.log];
    tampered.splice(1, 0, {
      from: 'available',
      to: 'complete',
      trigger: 'accept',
      actor: 'engine',
      at: '2026-09-17T09:01:00.000Z',
      attemptNumber: 0,
    });

    const replayed = replayMissionTransitions(
      createMissionProgress(MISSION),
      tampered,
      POLICY,
    );
    assert.equal(replayed.consistent, false);
    assert.equal(replayed.consistent === false && replayed.index, 1);
    assert.equal(replayed.consistent === false && replayed.refusal?.code, 'wrong-state');
  });

  it('names the line that ended somewhere the rules would not have put it', () => {
    const tampered: MissionTransition[] = [...progress.log];
    const rejected = tampered[3];
    assert.ok(rejected?.trigger === 'reject');
    // The team had a try left, so the rules hand the mission back. A stored
    // line claiming it ended the mission is exactly the kind of thing a
    // replay is for.
    tampered[3] = { ...rejected, to: 'failed' };

    const replayed = replayMissionTransitions(
      createMissionProgress(MISSION),
      tampered.slice(0, 4),
      POLICY,
    );
    assert.equal(replayed.consistent, false);
    assert.equal(replayed.consistent === false && replayed.index, 3);
    assert.ok(replayed.consistent === false && replayed.message.includes('available'));
  });

  it('stops where it stopped making sense, and says how far it got', () => {
    const tampered: MissionTransition[] = [...progress.log];
    const fifth = tampered[4];
    assert.ok(fifth !== undefined);
    tampered[4] = { ...fifth, trigger: 'verify' };

    const replayed = replayMissionTransitions(
      createMissionProgress(MISSION),
      tampered,
      POLICY,
    );
    assert.equal(replayed.consistent, false);
    assert.equal(replayed.consistent === false && replayed.progress.state, 'available');
    assert.equal(replayed.consistent === false && replayed.progress.log.length, 4);
  });
});

describe('a history replayed under a policy it was not played under', () => {
  it('disagrees, because the policy is part of what decided it', () => {
    const progress = played();
    const oneTryOnly: MissionStatePolicy = { maxAttempts: 1, allowSkip: true };

    const replayed = replayMissionTransitions(
      createMissionProgress(MISSION),
      progress.log,
      oneTryOnly,
    );
    assert.equal(replayed.consistent, false);
    // The rejection on the only allowed try ends the mission, so the stored
    // line saying it went back to `available` is the first disagreement.
    assert.equal(replayed.consistent === false && replayed.index, 3);
  });
});

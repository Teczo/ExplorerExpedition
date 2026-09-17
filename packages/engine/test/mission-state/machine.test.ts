/**
 * Playing a mission from one end to the other.
 *
 * Three promises are checked here. A mission walks the states the ticket
 * names; a record handed in comes back untouched; and a refusal changes
 * nothing at all, including the history.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toId, type MissionInstanceId } from '@explorer/shared-types';

import {
  applyMissionTransition,
  createMissionProgress,
  MissionTransitionRefusedError,
  requireMissionTransition,
  type MissionStatePolicy,
} from '../../src/mission-state/index.ts';

const MISSION: MissionInstanceId = toId('museum-puzzle');
const POLICY: MissionStatePolicy = { maxAttempts: 3, allowSkip: true };

describe('a mission from locked to complete', () => {
  it('walks the states a team would see', () => {
    let progress = createMissionProgress(MISSION);
    assert.equal(progress.state, 'locked');

    const seen: string[] = [progress.state];
    const script = [
      ['unlock', 'engine'],
      ['start', 'team'],
      ['submit', 'team'],
      ['accept', 'engine'],
    ] as const;

    for (const [trigger, actor] of script) {
      progress = requireMissionTransition(
        progress,
        { trigger, actor, at: '2026-09-17T10:00:00.000Z' },
        POLICY,
      );
      seen.push(progress.state);
    }

    assert.deepEqual(seen, ['locked', 'available', 'in-progress', 'submitted', 'complete']);
  });

  it('walks the other way round when a person has to look', () => {
    let progress = createMissionProgress(MISSION, { state: 'available' });
    const seen: string[] = [];
    for (const trigger of ['start', 'submit', 'refer', 'verify'] as const) {
      progress = requireMissionTransition(
        progress,
        {
          trigger,
          actor: trigger === 'verify' ? 'teacher' : 'team',
          at: '2026-09-17T10:00:00.000Z',
        },
        POLICY,
      );
      seen.push(progress.state);
    }
    assert.deepEqual(seen, ['in-progress', 'submitted', 'awaiting-verification', 'complete']);
  });
});

describe('a record handed to the machine', () => {
  const before = createMissionProgress(MISSION, { state: 'available' });

  it('comes back exactly as it went in', () => {
    const result = applyMissionTransition(
      before,
      { trigger: 'start', actor: 'team', at: '2026-09-17T10:00:00.000Z' },
      POLICY,
    );
    assert.equal(result.applied, true);
    assert.equal(before.state, 'available');
    assert.equal(before.attemptsUsed, 0);
    assert.deepEqual(before.log, []);
  });

  it('is not the record that comes out', () => {
    const result = applyMissionTransition(
      before,
      { trigger: 'start', actor: 'team', at: '2026-09-17T10:00:00.000Z' },
      POLICY,
    );
    assert.ok(result.applied && result.progress !== before);
    assert.ok(result.applied && result.progress.log !== before.log);
  });

  it('keeps the mission it is about', () => {
    const after = requireMissionTransition(
      before,
      { trigger: 'start', actor: 'team', at: '2026-09-17T10:00:00.000Z' },
      POLICY,
    );
    assert.equal(after.missionInstanceId, MISSION);
  });

  it('survives a round trip through JSON, because it is only data', () => {
    const after = requireMissionTransition(
      before,
      { trigger: 'start', actor: 'team', at: '2026-09-17T10:00:00.000Z' },
      POLICY,
    );
    assert.deepEqual(JSON.parse(JSON.stringify(after)), after);
  });
});

describe('a transition the rules will not make', () => {
  const submitted = requireMissionTransition(
    requireMissionTransition(
      createMissionProgress(MISSION, { state: 'available' }),
      { trigger: 'start', actor: 'team', at: '2026-09-17T10:00:00.000Z' },
      POLICY,
    ),
    { trigger: 'submit', actor: 'team', at: '2026-09-17T10:01:00.000Z' },
    POLICY,
  );

  it('changes nothing, and writes nothing down', () => {
    const again = applyMissionTransition(
      submitted,
      { trigger: 'submit', actor: 'team', at: '2026-09-17T10:01:01.000Z' },
      POLICY,
    );
    assert.equal(again.applied, false);
    assert.equal(again.progress, submitted);
    assert.equal(again.progress.log.length, 2);
  });

  it('says where the mission is and what it would have taken', () => {
    const again = applyMissionTransition(
      submitted,
      { trigger: 'submit', actor: 'team', at: '2026-09-17T10:01:01.000Z' },
      POLICY,
    );
    assert.equal(again.applied === false && again.refusal.state, 'submitted');
    assert.ok(again.applied === false && again.refusal.message.includes('in-progress'));
  });

  it('throws only when the caller insisted', () => {
    assert.throws(
      () =>
        requireMissionTransition(
          submitted,
          { trigger: 'submit', actor: 'team', at: '2026-09-17T10:01:01.000Z' },
          POLICY,
        ),
      (error: unknown) => {
        assert.ok(error instanceof MissionTransitionRefusedError);
        assert.equal(error.refusal.code, 'wrong-state');
        return true;
      },
    );
  });
});

describe('a mission that has finished', () => {
  const skipped = requireMissionTransition(
    createMissionProgress(MISSION, { state: 'available' }),
    { trigger: 'skip', actor: 'team', at: '2026-09-17T10:00:00.000Z' },
    POLICY,
  );

  it('stays finished, whatever arrives late', () => {
    for (const trigger of ['start', 'accept', 'verify', 'unlock', 'expire'] as const) {
      const result = applyMissionTransition(
        skipped,
        { trigger, actor: 'engine', at: '2026-09-17T11:00:00.000Z' },
        POLICY,
      );
      assert.equal(result.applied, false, trigger);
      assert.equal(result.applied === false && result.refusal.code, 'terminal-state');
      assert.equal(result.progress.state, 'skipped');
    }
  });
});

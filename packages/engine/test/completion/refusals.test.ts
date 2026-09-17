/**
 * Work the interface would not check, and what it leaves behind.
 *
 * The line this file draws is the one the ticket rests on: a refusal is not a
 * wrong answer. A wrong answer is a try spent and something the scoring
 * engine (EXPD-012) may take points for; work that was never checked is
 * neither, so nothing may move and nothing may be written down.
 *
 * Every refusal here is a team playing normally — a second tap on submit, a
 * phone sending a queued submission after the mission timed out, a team
 * standing in the wrong street.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  JsonObject,
  MissionInstance,
  MissionProgress,
} from '@explorer/shared-types';

import { createMissionTypeRegistry } from '../../src/mission-types/index.ts';
import {
  applyMissionTransition,
  createMissionProgress,
} from '../../src/mission-state/index.ts';
import {
  completeMission,
  type CompletionResult,
} from '../../src/completion/complete.ts';
import { missionCompletionPolicyFor } from '../../src/completion/policy.ts';
import {
  at,
  brokenType,
  byHand,
  codeMatch,
  evidence,
  missionOf,
  mustBeAt,
  nonsenseType,
  openedMission,
  rulesOf,
} from './support.ts';

const registry = createMissionTypeRegistry([
  codeMatch,
  evidence,
  byHand,
  brokenType,
  nonsenseType,
]);
const mission = missionOf('code-match', { config: { wanted: 'EXPD-7742' } });

/** One submission of the right answer, against whatever mission is given. */
function hand(
  progress: MissionProgress,
  instance: MissionInstance = mission,
  payload: JsonObject = { scanned: 'EXPD-7742' },
): CompletionResult {
  return completeMission({
    kind: 'submission',
    registry,
    mission: instance,
    progress,
    payload,
    at: at(30),
    completionPolicy: missionCompletionPolicyFor(instance, rulesOf(false)),
  });
}

describe('work the state machine would not take', () => {
  it('is refused when the team never opened the mission', () => {
    const locked = createMissionProgress(mission.id);
    const result = hand(locked);

    assert.equal(result.applied, false);
    if (result.applied) {
      return;
    }
    assert.equal(result.refusal.code, 'not-now');
    assert.equal(result.refusal.stateRefusal?.code, 'wrong-state');
    assert.deepEqual(result.progress, locked);
  });

  it('is refused on the second tap of submit', () => {
    const first = hand(openedMission(mission.id), missionOf('evidence'), { mediaId: 'm-1' });
    assert.equal(first.applied, true);
    if (!first.applied) {
      return;
    }

    // The mission is waiting on a teacher now, so the same tap arriving twice
    // changes nothing and writes nothing.
    const second = hand(first.progress, missionOf('evidence'), { mediaId: 'm-1' });
    assert.equal(second.applied, false);
    if (second.applied) {
      return;
    }
    assert.equal(second.refusal.code, 'not-now');
    assert.deepEqual(second.progress.log, first.progress.log);
  });

  it('is refused on a mission that has already finished', () => {
    const done = hand(openedMission(mission.id));
    assert.equal(done.applied, true);
    if (!done.applied) {
      return;
    }

    const again = hand(done.progress);
    assert.equal(again.applied, false);
    if (again.applied) {
      return;
    }
    assert.equal(again.refusal.stateRefusal?.code, 'terminal-state');
  });

  it('is refused when the team has used every try', () => {
    const policy = { maxAttempts: 1, allowSkip: false };
    const progress = openedMission(mission.id, policy);
    const wrong = completeMission({
      kind: 'submission',
      registry,
      mission,
      progress,
      payload: { scanned: 'nope' },
      at: at(30),
      statePolicy: policy,
    });
    assert.equal(wrong.applied, true);
    if (!wrong.applied) {
      return;
    }
    // The last try being wrong ends the mission, rather than handing it back.
    assert.equal(wrong.progress.state, 'failed');
  });

  it('is refused when a timer goes off on a mission nobody is playing', () => {
    // Two things are wrong with this and only one answer is useful. The
    // mission is not running, so that is what it says, rather than doing
    // arithmetic on a clock that was never started.
    const timedMission = missionOf('by-hand', { timeLimitSeconds: 300 });
    const locked = createMissionProgress(timedMission.id);
    const result = completeMission({
      kind: 'expiry',
      progress: locked,
      at: at(9999),
      completionPolicy: missionCompletionPolicyFor(timedMission, rulesOf(false)),
    });

    assert.equal(result.applied, false);
    if (result.applied) {
      return;
    }
    assert.equal(result.refusal.code, 'not-now');
    assert.equal(result.refusal.stateRefusal?.code, 'wrong-state');
    assert.deepEqual(result.progress, locked);
  });

  it('is refused when a teacher reviews a mission nobody referred', () => {
    const progress = openedMission(mission.id);
    const result = completeMission({
      kind: 'review',
      progress,
      decision: 'approve',
      at: at(600),
    });

    assert.equal(result.applied, false);
    if (result.applied) {
      return;
    }
    assert.equal(result.refusal.code, 'not-now');
    assert.deepEqual(result.progress, progress);
  });
});

describe('work that is not the shape the mission type takes', () => {
  it('is refused, with the field named', () => {
    const progress = openedMission(mission.id);
    const result = hand(progress, mission, { scanned: 42 });

    assert.equal(result.applied, false);
    if (result.applied) {
      return;
    }
    assert.equal(result.refusal.code, 'invalid-submission');
    assert.equal(result.refusal.issues?.[0]?.path, 'payload.scanned');
    assert.deepEqual(result.progress, progress);
  });

  it('is refused before the mission type is ever run', () => {
    // The broken type throws the moment it is asked anything. A payload that
    // never gets that far proves the shape is checked first.
    const broken = missionOf('broken');
    const result = hand(openedMission(broken.id), broken, { note: 7 });

    assert.equal(result.applied, false);
    if (result.applied) {
      return;
    }
    assert.equal(result.refusal.code, 'invalid-submission');
  });
});

describe('a mission naming a type nothing has registered', () => {
  it('is refused rather than guessed at', () => {
    const unknown = missionOf('not-a-real-type');
    const progress = openedMission(unknown.id);
    const result = hand(progress, unknown, { anything: true });

    assert.equal(result.applied, false);
    if (result.applied) {
      return;
    }
    assert.equal(result.refusal.code, 'unknown-mission-type');
    assert.match(result.refusal.message, /not-a-real-type@1\.0\.0/);
    assert.deepEqual(result.progress, progress);
  });
});

describe('a mission type with a bug in it', () => {
  it('sends the work to a teacher rather than failing the team', () => {
    const broken = missionOf('broken');
    const result = hand(openedMission(broken.id), broken, { note: 'Done.' });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.equal(result.verdict.outcome, 'needs-review');
    assert.equal(result.verdict.method, 'referral');
    assert.equal(result.progress.state, 'awaiting-verification');
    assert.match(result.verdict.reason ?? '', /cannot read the answer key/);
    // The team is told nothing about it.
    assert.equal(result.verdict.feedback, undefined);
  });

  it('does the same when it answers with something that is not an outcome', () => {
    const nonsense = missionOf('nonsense');
    const result = hand(openedMission(nonsense.id), nonsense, { note: 'Done.' });

    assert.equal(result.applied, true);
    if (!result.applied) {
      return;
    }
    assert.equal(result.verdict.outcome, 'needs-review');
    assert.match(result.verdict.reason ?? '', /not an outcome/);
  });
});

describe('a refusal, whichever one it is', () => {
  const cases: Array<[string, CompletionResult]> = [];

  const locked = createMissionProgress(mission.id);
  cases.push(['not-now', hand(locked)]);
  cases.push(['invalid-submission', hand(openedMission(mission.id), mission, { scanned: 1 })]);
  cases.push([
    'unknown-mission-type',
    hand(openedMission('mission-x'), missionOf('missing'), {}),
  ]);

  const placed = missionOf('by-hand', { location: mustBeAt() });
  cases.push([
    'wrong-place',
    completeMission({
      kind: 'submission',
      registry,
      mission: placed,
      progress: openedMission(placed.id),
      payload: { note: 'here' },
      position: { latitude: 51.5045, longitude: -0.1275 },
      at: at(30),
      completionPolicy: missionCompletionPolicyFor(placed, rulesOf(false)),
    }),
  ]);

  const timedMission = missionOf('by-hand', { timeLimitSeconds: 300 });
  cases.push([
    'not-yet-expired',
    completeMission({
      kind: 'expiry',
      progress: openedMission(timedMission.id),
      at: at(10),
      completionPolicy: missionCompletionPolicyFor(timedMission, rulesOf(false)),
    }),
  ]);

  for (const [code, result] of cases) {
    it(`says ${code}, and leaves the mission exactly as it was`, () => {
      assert.equal(result.applied, false);
      if (result.applied) {
        return;
      }
      assert.equal(result.refusal.code, code);
      assert.equal(result.progress.log.length, result.progress.state === 'locked' ? 0 : 1);
      assert.notEqual(result.refusal.message, '');
      // A refusal never carries a verdict. Nothing was concluded.
      assert.equal('verdict' in result, false);
    });
  }
});

describe('the record a check leaves behind', () => {
  it('replays to the state the mission ended in', () => {
    // Every line the interface writes is one the state machine made, so the
    // history it leaves is one that replays. If it ever wrote a line itself,
    // this is what would catch it.
    const first = hand(openedMission(mission.id), mission, { scanned: 'nope' });
    assert.equal(first.applied, true);
    if (!first.applied) {
      return;
    }

    let progress = createMissionProgress(mission.id, { state: 'available' });
    for (const line of first.progress.log) {
      const step = applyMissionTransition(progress, line);
      assert.equal(step.applied, true, line.trigger);
      if (step.applied) {
        progress = step.progress;
      }
    }
    assert.equal(progress.state, first.progress.state);
    assert.equal(progress.attemptsUsed, first.progress.attemptsUsed);
  });

  it('gives the same answer twice for the same request', () => {
    const progress = openedMission(mission.id);
    assert.deepEqual(hand(progress), hand(progress));
  });
});

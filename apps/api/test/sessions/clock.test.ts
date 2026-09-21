/**
 * The arithmetic behind "ten minutes left" (EXPD-019).
 *
 * These are the only tests in this ticket that do not go over a socket, and
 * the reason is the clock itself: every figure it works out depends on what
 * time it is, and a test that could not say what time it is would be reduced
 * to checking that a number is roughly another number. `sessionClock` takes
 * `now` as a parameter for exactly this, so here the clock is asked what a
 * run looks like at a stated moment and the answer is exact.
 *
 * `timing-rules.ts` is tested here too, for the same reason `team-rules.ts`
 * is tested beside its endpoints: what it promises is that a short or an odd
 * document falls back rather than throwing, and that is a statement about
 * values, not about requests.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { SessionStatus, TimingRules } from '@explorer/shared-types';

import {
  currentPauseSeconds,
  sessionClock,
  type SessionClockInput,
} from '../../src/sessions/session-clock.ts';
import {
  DEFAULT_TIMING_RULES,
  endsOnTime,
  timeLimitOf,
  timingRulesOf,
} from '../../src/sessions/timing-rules.ts';

/** Noon, and the moment every test below reads the clock at. */
const NOW = new Date('2026-03-03T12:00:00.000Z');

/** A moment a number of minutes before noon. */
function before(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60_000);
}

/** A run, with only the columns the clock reads. */
function run(over: Partial<SessionClockInput> = {}): SessionClockInput {
  return {
    status: 'running' as SessionStatus,
    startedAt: before(30),
    pausedAt: null,
    pausedSecondsTotal: 0,
    extendedSecondsTotal: 0,
    endedAt: null,
    ...over,
  };
}

/** Rules with a time limit on them. */
function limited(seconds: number): TimingRules {
  return { startMode: 'synchronised', endMode: 'time-limit', totalTimeLimitSeconds: seconds };
}

describe('how long a run has been going', () => {
  test('is nothing at all before it starts', () => {
    const clock = sessionClock(
      run({ status: 'lobby', startedAt: null }),
      DEFAULT_TIMING_RULES,
      NOW,
    );

    assert.equal(clock.elapsedSeconds, null);
    assert.equal(clock.pausedSeconds, 0);
    assert.equal(clock.expired, false);
  });

  test('is wall time once it has', () => {
    assert.equal(sessionClock(run(), DEFAULT_TIMING_RULES, NOW).elapsedSeconds, 1_800);
  });

  test('takes every finished pause back out', () => {
    const clock = sessionClock(
      run({ pausedSecondsTotal: 300 }),
      DEFAULT_TIMING_RULES,
      NOW,
    );

    assert.equal(clock.elapsedSeconds, 1_500);
    assert.equal(clock.pausedSeconds, 300);
  });

  test('takes the pause going on right now out as well', () => {
    const clock = sessionClock(
      run({ status: 'paused', pausedAt: before(5) }),
      DEFAULT_TIMING_RULES,
      NOW,
    );

    assert.equal(clock.pausedSeconds, 300);
    assert.equal(clock.elapsedSeconds, 1_500);
  });

  test('sits still while a run stays paused', () => {
    const paused = run({ status: 'paused', pausedAt: before(5) });
    const later = new Date(NOW.getTime() + 10 * 60_000);

    assert.equal(
      sessionClock(paused, DEFAULT_TIMING_RULES, NOW).elapsedSeconds,
      sessionClock(paused, DEFAULT_TIMING_RULES, later).elapsedSeconds,
    );
  });

  test('stops at the ending, not at the reading', () => {
    const ended = run({ status: 'ended', startedAt: before(90), endedAt: before(30) });
    const tomorrow = new Date(NOW.getTime() + 24 * 3_600_000);

    assert.equal(sessionClock(ended, DEFAULT_TIMING_RULES, NOW).elapsedSeconds, 3_600);
    assert.equal(
      sessionClock(ended, DEFAULT_TIMING_RULES, tomorrow).elapsedSeconds,
      3_600,
    );
  });

  test('is never negative, whatever the clocks say', () => {
    const clock = sessionClock(
      run({ startedAt: new Date(NOW.getTime() + 60_000) }),
      DEFAULT_TIMING_RULES,
      NOW,
    );

    assert.equal(clock.elapsedSeconds, 0);
  });
});

describe('how long is left', () => {
  test('is nothing to answer when the expedition set no limit', () => {
    const clock = sessionClock(run(), DEFAULT_TIMING_RULES, NOW);

    assert.equal(clock.limitSeconds, null);
    assert.equal(clock.remainingSeconds, null);
    assert.equal(clock.endsAt, null);
    assert.equal(clock.expired, false);
  });

  test('is the limit less the time played', () => {
    const clock = sessionClock(run(), limited(3_600), NOW);

    assert.equal(clock.remainingSeconds, 1_800);
    assert.equal(clock.endsAt?.toISOString(), '2026-03-03T12:30:00.000Z');
  });

  test('grows by a pause, because the pause is not played time', () => {
    const clock = sessionClock(run({ pausedSecondsTotal: 600 }), limited(3_600), NOW);

    assert.equal(clock.remainingSeconds, 2_400);
    assert.equal(clock.endsAt?.toISOString(), '2026-03-03T12:40:00.000Z');
  });

  test('grows by an extension', () => {
    const clock = sessionClock(run({ extendedSecondsTotal: 900 }), limited(3_600), NOW);

    assert.equal(clock.limitSeconds, 4_500);
    assert.equal(clock.remainingSeconds, 2_700);
  });

  test('stops at nothing left rather than going negative', () => {
    const clock = sessionClock(run({ startedAt: before(120) }), limited(3_600), NOW);

    assert.equal(clock.remainingSeconds, 0);
    assert.equal(clock.expired, true);
  });

  test('has no end time while the run is paused', () => {
    const clock = sessionClock(
      run({ status: 'paused', pausedAt: before(5) }),
      limited(3_600),
      NOW,
    );

    assert.equal(clock.endsAt, null);
    assert.equal(clock.remainingSeconds, 2_100);
  });

  test('says whether the clock is what ends this expedition', () => {
    assert.equal(sessionClock(run(), limited(3_600), NOW).endsOnTime, true);
    assert.equal(
      sessionClock(run(), { ...limited(3_600), endMode: 'teacher-ends' }, NOW)
        .endsOnTime,
      false,
    );
  });
});

describe('the pause a resume folds in', () => {
  test('is nothing when the run is not paused', () => {
    assert.equal(currentPauseSeconds(null, NOW), 0);
  });

  test('is whole seconds since the pause began', () => {
    assert.equal(currentPauseSeconds(before(5), NOW), 300);
  });
});

describe('reading the timing out of a stored document', () => {
  test('falls back to a run nothing but a teacher ends', () => {
    for (const document of [null, {}, { rules: {} }, { rules: { timing: 7 } }]) {
      assert.deepEqual(timingRulesOf(document as never), DEFAULT_TIMING_RULES);
    }
  });

  test('reads the modes and the limit the author wrote', () => {
    const rules = timingRulesOf({
      rules: {
        timing: {
          startMode: 'on-join',
          endMode: 'time-limit',
          totalTimeLimitSeconds: 3_600,
          countdownSeconds: 30,
        },
      },
    });

    assert.deepEqual(rules, {
      startMode: 'on-join',
      endMode: 'time-limit',
      totalTimeLimitSeconds: 3_600,
      countdownSeconds: 30,
    });
  });

  test('falls back on a mode it does not know', () => {
    const rules = timingRulesOf({
      rules: { timing: { startMode: 'whenever', endMode: 'never' } },
    });

    assert.equal(rules.startMode, 'synchronised');
    assert.equal(rules.endMode, 'teacher-ends');
  });

  test('drops a limit that is not a whole number of seconds in range', () => {
    for (const value of [0, -60, 1.5, '3600', 999_999]) {
      const rules = timingRulesOf({
        rules: { timing: { endMode: 'time-limit', totalTimeLimitSeconds: value } },
      });

      assert.equal(rules.totalTimeLimitSeconds, undefined, String(value));
    }
  });

  test('a dropped limit means no limit, not a default one', () => {
    const rules = timingRulesOf({
      rules: { timing: { endMode: 'time-limit', totalTimeLimitSeconds: -1 } },
    });

    assert.equal(timeLimitOf(rules, 0), null);
    assert.equal(endsOnTime(rules), true);
  });

  test('the limit a class plays to is the document plus the extensions', () => {
    assert.equal(timeLimitOf(limited(3_600), 0), 3_600);
    assert.equal(timeLimitOf(limited(3_600), 600), 4_200);
    assert.equal(timeLimitOf(DEFAULT_TIMING_RULES, 600), null);
  });
});

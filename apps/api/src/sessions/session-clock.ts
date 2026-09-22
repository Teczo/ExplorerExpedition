/**
 * How long a run has been going, and how long is left (EXPD-019).
 *
 * The runtime state every team in a run shares. A team has its own progress
 * (EXPD-013) and its own score (EXPD-012), and both are worked out against
 * one clock — this one — so that "ten minutes left" means the same thing on
 * thirty phones and on the teacher's dashboard.
 *
 * Four columns and one number from the document are all it reads:
 *
 *     started_at              when play began
 *     paused_at               when the pause going on now began, or NULL
 *     paused_seconds_total    every pause before that one, added up
 *     extended_seconds_total  time a teacher gave the class on the day
 *     rules.timing            the revision's own limit, if it set one
 *
 * Nothing is cached and nothing is stored: every answer here is worked out
 * from those on each read. That is deliberate. A stored "seconds remaining"
 * is wrong the moment it is written, and a stored "ends at" is wrong the
 * moment somebody pauses — and pausing is the whole point of the feature.
 *
 * **Pausing stops the clock, it does not move the end.** Elapsed time is wall
 * time since the start with every paused second taken back out, so a run
 * paused for twenty minutes finishes twenty minutes later than it would have
 * and no team loses a second of play. `pausedSeconds` below includes the
 * pause going on right now, which is what makes the elapsed figure sit still
 * while a run is paused.
 *
 * **Nothing here ends a run.** A run whose time is up reads `expired`, and
 * goes on being `running` until somebody ends it. There is no timer in the
 * API, and a run that ended itself while every phone was offline would be the
 * worse behaviour. Turning `expired` into an ending is Director Mode's
 * (EXPD-055) or a live trigger's (EXPD-057).
 *
 * Seconds throughout, whole ones, rounded down, and never below zero —
 * matching EXPD-002, which counts every duration in whole seconds.
 */

import type { SessionStatus, TimingRules } from '@explorer/shared-types';

import { endsOnTime, timeLimitOf } from './timing-rules.ts';

/** The columns of a run this file reads, and no others. */
export interface SessionClockInput {
  readonly status: SessionStatus;
  readonly startedAt: Date | null;
  readonly pausedAt: Date | null;
  readonly pausedSecondsTotal: number;
  readonly extendedSecondsTotal: number;
  readonly endedAt: Date | null;
}

/** Where a run stands, as of one moment. */
export interface SessionClock {
  /** The moment every other field here was worked out at. */
  readonly now: Date;
  /** Play time so far, pauses taken out. Null before the run starts. */
  readonly elapsedSeconds: number | null;
  /** Every paused second so far, the pause going on now included. */
  readonly pausedSeconds: number;
  /** The revision's limit plus everything added on the day. Null when uncapped. */
  readonly limitSeconds: number | null;
  /** How much of the limit is left. Null when there is no limit. */
  readonly remainingSeconds: number | null;
  /** Time a teacher added to this run. */
  readonly extendedSeconds: number;
  /** When the time runs out, if it is running towards that. */
  readonly endsAt: Date | null;
  /** True when a limit exists and the run has used all of it. */
  readonly expired: boolean;
  /** True when running out of time is what ends this expedition. */
  readonly endsOnTime: boolean;
}

/**
 * Works out where a run stands.
 *
 * `now` is a parameter rather than a call to the clock inside, so that a test
 * can ask what a run looks like at a given moment and so that one request
 * answering about several runs dates them all the same.
 */
export function sessionClock(
  input: SessionClockInput,
  rules: TimingRules,
  now: Date,
): SessionClock {
  const limitSeconds = timeLimitOf(rules, input.extendedSecondsTotal);
  const pausedSeconds = pausedSecondsAt(input, now);
  const elapsedSeconds = elapsedSecondsAt(input, pausedSeconds, now);

  const remainingSeconds =
    limitSeconds === null || elapsedSeconds === null
      ? limitSeconds
      : Math.max(0, limitSeconds - elapsedSeconds);

  return {
    now,
    elapsedSeconds,
    pausedSeconds,
    limitSeconds,
    remainingSeconds,
    extendedSeconds: Math.max(0, Math.trunc(input.extendedSecondsTotal)),
    endsAt: endsAtOf(input.status, remainingSeconds, now),
    expired: remainingSeconds === 0 && elapsedSeconds !== null,
    endsOnTime: endsOnTime(rules),
  };
}

/**
 * Every paused second so far, the pause going on right now included.
 *
 * The stored total only counts pauses that have ended, because a resume is
 * what adds to it. While a run is paused the current pause is still growing,
 * so it is added here rather than written to the row every second.
 */
export function pausedSecondsAt(input: SessionClockInput, now: Date): number {
  const stored = Math.max(0, Math.trunc(input.pausedSecondsTotal));
  if (input.pausedAt === null) {
    return stored;
  }
  return stored + secondsBetween(input.pausedAt, input.endedAt ?? now);
}

/**
 * How long the current pause has lasted, in whole seconds.
 *
 * What a resume adds to `paused_seconds_total`, and what ending a paused run
 * folds in before it clears `paused_at`.
 */
export function currentPauseSeconds(pausedAt: Date | null, now: Date): number {
  return pausedAt === null ? 0 : secondsBetween(pausedAt, now);
}

/**
 * Play time so far, in whole seconds, or null before the run has started.
 *
 * Measured to the moment the run ended once it has ended, so that a finished
 * run reads the same an hour later as it did the second it stopped.
 */
function elapsedSecondsAt(
  input: SessionClockInput,
  pausedSeconds: number,
  now: Date,
): number | null {
  if (input.startedAt === null) {
    return null;
  }
  const wall = secondsBetween(input.startedAt, input.endedAt ?? now);
  return Math.max(0, wall - pausedSeconds);
}

/**
 * When the time runs out.
 *
 * Only a run that is `running` has one. A paused run's end time moves with
 * every second it stays paused, so answering with "now plus what is left"
 * would hand a client a time that slides away from it; and a run that has not
 * started or has finished is not counting down at all. Null in all three
 * cases, and `remainingSeconds` is what a client shows instead.
 */
function endsAtOf(
  status: SessionStatus,
  remainingSeconds: number | null,
  now: Date,
): Date | null {
  if (status !== 'running' || remainingSeconds === null) {
    return null;
  }
  return new Date(now.getTime() + remainingSeconds * 1000);
}

/** Whole seconds from one moment to another, never negative. */
function secondsBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 1000));
}

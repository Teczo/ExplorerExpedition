/**
 * What the lifecycle endpoints answer with (EXPD-019).
 *
 * A row is what PostgreSQL returned, snake case and all. A view is what a
 * client reads. This file is the one place the first becomes the second, the
 * way `expeditions/views.ts` is for EXPD-017 and `participation/views.ts` is
 * for EXPD-018.
 *
 * Two things are worth saying about the shape.
 *
 * **Every endpoint answers with the whole run.** Starting one, pausing one
 * and adding ten minutes to one all come back as the same `SessionView`, not
 * as a confirmation of the thing that changed. A Director Mode dashboard
 * (EXPD-055) that pressed *pause* wants the clock, the state and the code
 * back in one answer, and a client that had to press a button and then read
 * the run again would draw a stale toolbar for a round trip.
 *
 * **The clock is worked out, not stored.** `clock` is
 * `sessions/session-clock.ts` run over the row at the moment of the read, so
 * `now` is part of the answer: a client that knows when a figure was worked
 * out can go on counting down between requests without asking again.
 *
 * `SessionSummaryView` is EXPD-018's, and it is reused here rather than
 * copied. A run has one summary shape whichever ticket is looking at it.
 */

import type { SessionStatus } from '@explorer/shared-types';
import { isFinalSessionStatus, isJoinableSessionStatus } from '@explorer/shared-types';

import {
  toSessionSummaryView,
  type SessionSummaryView,
} from '../participation/views.ts';
import type { ExpeditionSessionRow } from '../repositories/rows.ts';
import type { SessionClock } from './session-clock.ts';

/** Where a run stands, as a client reads it. */
export interface SessionClockView {
  /** When these figures were worked out. Everything else is as of this moment. */
  readonly now: string;
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
  /** When the time runs out. Only a run that is running has one. */
  readonly endsAt: string | null;
  /** True when a limit exists and the run has used all of it. */
  readonly expired: boolean;
  /** True when running out of time is what ends this expedition. */
  readonly endsOnTime: boolean;
}

/** One run, with everything about it a client acts on. */
export interface SessionView extends SessionSummaryView {
  readonly joinCode: string;
  /** False once a run is over: the code no longer reaches it. */
  readonly joinable: boolean;
  /** True once a run is over, whether it was played or called off. */
  readonly finished: boolean;
  /** The teacher running it, and the one Director Mode belongs to. */
  readonly hostUserId: string | null;
  readonly scheduledStartAt: string | null;
  readonly startedAt: string | null;
  readonly pausedAt: string | null;
  readonly endedAt: string | null;
  readonly createdAt: string;
  readonly clock: SessionClockView;
  /** The states this run may move to next, given where it is now. */
  readonly nextStatuses: readonly SessionStatus[];
}

/** One page of runs. */
export interface SessionListView {
  readonly sessions: readonly SessionView[];
  /** How many the filter matches in all, not how many are on this page. */
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/** Turns a run and its clock into the shape a client reads. */
export function toSessionView(
  row: ExpeditionSessionRow,
  clock: SessionClock,
  nextStatuses: readonly SessionStatus[],
): SessionView {
  return {
    ...toSessionSummaryView(row),
    joinCode: row.join_code,
    joinable: isJoinableSessionStatus(row.status),
    finished: isFinalSessionStatus(row.status),
    hostUserId: row.host_user_id,
    scheduledStartAt: timeOf(row.scheduled_start_at),
    startedAt: timeOf(row.started_at),
    pausedAt: timeOf(row.paused_at),
    endedAt: timeOf(row.ended_at),
    createdAt: timeOf(row.created_at) ?? '',
    clock: toClockView(clock),
    nextStatuses: [...nextStatuses],
  };
}

/** Turns the worked-out clock into the shape a client reads. */
export function toClockView(clock: SessionClock): SessionClockView {
  return {
    now: clock.now.toISOString(),
    elapsedSeconds: clock.elapsedSeconds,
    pausedSeconds: clock.pausedSeconds,
    limitSeconds: clock.limitSeconds,
    remainingSeconds: clock.remainingSeconds,
    extendedSeconds: clock.extendedSeconds,
    endsAt: clock.endsAt === null ? null : clock.endsAt.toISOString(),
    expired: clock.expired,
    endsOnTime: clock.endsOnTime,
  };
}

/**
 * A time as a client reads it.
 *
 * `pg` gives back a `Date` for a `timestamptz`, and `FakeDatabase` gives back
 * whatever a test seeded, which may already be a string, or nothing at all
 * where the real column has a default. All three are answered the same way
 * rather than one of them throwing — the same reasoning as
 * `participation/views.ts`.
 */
function timeOf(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * Which state a run may move to next (EXPD-019).
 *
 * `statuses.ts` lists the six states a run can be in and says nothing about
 * the order they come in. This file is that order, and it is the whole of it:
 * one table, and the small questions asked about it.
 *
 * It lives here rather than in the API because three sides read it. The API
 * enforces it. Director Mode (EXPD-055) greys out the buttons a run cannot
 * take right now. The student app (EXPD-047) is told a run changed state and
 * has to know whether that means play has begun or is over. A copy in each of
 * them would be three tables that drift.
 *
 * The table, drawn out:
 *
 *            ┌────────────┐
 *            │ scheduled  │──────────────┐
 *            └─────┬──────┘              │
 *                  │ start               │ end, before play
 *            ┌─────▼──────┐              │
 *      ┌─────│  running   │◄──┐          │
 *      │     └─────┬──────┘   │ resume   │
 *      │ end       │ pause    │          │
 *      │     ┌─────▼──────┐   │          │
 *      │     │   paused   │───┘          │
 *      │     └─────┬──────┘              │
 *      │           │ end                 │
 *      │     ┌─────▼──────┐        ┌─────▼──────┐
 *      └────►│   ended    │        │ cancelled  │
 *            └────────────┘        └────────────┘
 *
 * `lobby` is the same as `scheduled` for every purpose in this table: a run
 * made to be played now opens in it, a run made for later waits in
 * `scheduled`, and both are joinable and both can be started. Nothing moves a
 * run from one to the other, because the state a run opens in is decided once
 * when it is made.
 *
 * `ended` and `cancelled` are final. There is no reopening a run: a class
 * that wants to play again gets a new run, with a new code and a clean sheet,
 * which is what a second lesson is.
 */

import type { SessionStatus } from './statuses.ts';

/**
 * What a teacher can do to a run.
 *
 * Four of the five change the state. `extend` does not — it adds time to a
 * run that is already going — and it is in the list because it is refused in
 * the same states the others are, and a client drawing a Director Mode
 * toolbar wants one list rather than two.
 */
export const SESSION_COMMANDS = [
  /** Begin play. The clock starts now. */
  'start',
  /** Stop the clock, leaving the run where it is. */
  'pause',
  /** Start the clock again. */
  'resume',
  /** Give every team more time. */
  'extend',
  /** Stop the run for good. */
  'end',
] as const;

/** One thing a teacher can do to a run. */
export type SessionCommand = (typeof SESSION_COMMANDS)[number];

/**
 * The states a run can move to from each state.
 *
 * Every entry is a complete answer, including the two empty ones: a run that
 * has ended or been called off moves nowhere, and the table says so rather
 * than leaving the question open.
 */
export const SESSION_TRANSITIONS: Readonly<
  Record<SessionStatus, readonly SessionStatus[]>
> = {
  scheduled: ['running', 'cancelled'],
  lobby: ['running', 'cancelled'],
  running: ['paused', 'ended'],
  paused: ['running', 'ended'],
  ended: [],
  cancelled: [],
};

/**
 * The states in which a run is being played.
 *
 * A paused run is a run being played with the clock stopped, so it is in the
 * list. This is what "live" means everywhere else in the platform: a mission
 * can be attempted, a submission can arrive, a score can move.
 */
export const LIVE_SESSION_STATUSES = [
  'running',
  'paused',
] as const satisfies readonly SessionStatus[];

/**
 * The states a run never leaves.
 *
 * The same two states migration 0001 asks for an `ended_at` on, and the two
 * `JOINABLE_SESSION_STATUSES` leaves out — a run nobody can join is a run
 * nobody can rejoin either.
 */
export const FINAL_SESSION_STATUSES = [
  'ended',
  'cancelled',
] as const satisfies readonly SessionStatus[];

/**
 * The states a run that has not been played yet sits in.
 *
 * Students can join, teams can be made up, and no clock is running.
 */
export const PREGAME_SESSION_STATUSES = [
  'scheduled',
  'lobby',
] as const satisfies readonly SessionStatus[];

/** Returns true when a run in this state is being played. */
export function isLiveSessionStatus(value: unknown): value is SessionStatus {
  return includes(LIVE_SESSION_STATUSES, value);
}

/** Returns true when a run in this state is over, one way or the other. */
export function isFinalSessionStatus(value: unknown): value is SessionStatus {
  return includes(FINAL_SESSION_STATUSES, value);
}

/** Returns true when a run in this state has not been started yet. */
export function isPregameSessionStatus(value: unknown): value is SessionStatus {
  return includes(PREGAME_SESSION_STATUSES, value);
}

/** Returns true when a run in `from` may move to `to`. */
export function canSessionMove(from: SessionStatus, to: SessionStatus): boolean {
  return SESSION_TRANSITIONS[from].includes(to);
}

/**
 * What a command leaves a run in, or null when the run cannot take it.
 *
 * The one place the five commands and the six states meet. `extend` answers
 * with the state the run is already in, because it changes the clock and not
 * the state, and it answers `null` for a run that is not being played —
 * there is nothing to add time to before a run starts or after it is over.
 *
 * `end` answers `cancelled` for a run that was never started and `ended` for
 * one that was. That is the whole difference between the two words: a run
 * that was called off and a run that was played and finished.
 */
export function sessionStatusAfter(
  from: SessionStatus,
  command: SessionCommand,
  options: { readonly started: boolean },
): SessionStatus | null {
  const wanted = wantedStatus(from, command, options.started);
  if (wanted === null) {
    return null;
  }
  if (command === 'extend') {
    return isLiveSessionStatus(from) ? from : null;
  }
  return canSessionMove(from, wanted) ? wanted : null;
}

/** The state a command is aiming at, before the table is consulted. */
function wantedStatus(
  from: SessionStatus,
  command: SessionCommand,
  started: boolean,
): SessionStatus | null {
  switch (command) {
    case 'start':
      return 'running';
    case 'pause':
      return 'paused';
    case 'resume':
      return 'running';
    case 'end':
      return started ? 'ended' : 'cancelled';
    case 'extend':
      return from;
    default:
      return null;
  }
}

/** Whether a list of states holds this value. */
function includes(statuses: readonly SessionStatus[], value: unknown): boolean {
  return typeof value === 'string' && (statuses as readonly string[]).includes(value);
}

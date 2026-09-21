/**
 * The clock the engine does not have (EXPD-015).
 *
 * Every other folder in this package says the same thing at the top: the
 * engine holds no clock, and whoever owns the clock passes the moment in.
 * This is the harness owning one. It is the only new thing a simulated run
 * brings to the engine, and it is deliberately not a real clock — it is a
 * number of seconds since the run began, which the harness moves forward
 * itself when it decides a team spent that long walking or thinking.
 *
 * That is what makes a run both fast and honest. An afternoon of play is a
 * few thousand additions rather than an afternoon, and a mission's own time
 * limit (EXPD-011) is still measured against exactly the timestamps the
 * engine would have been given on the day.
 *
 * It is a plain value, and moving it on gives back a new one, the same way
 * every record in the engine does.
 */

import type { IsoTimestamp, Seconds } from '@explorer/shared-types';

/**
 * When a run begins when nobody says otherwise.
 *
 * A fixed instant rather than `new Date()`, because two runs of the same
 * expedition have to produce the same timestamps, and a report nobody can
 * compare with yesterday's is half a report.
 */
export const DEFAULT_SIMULATION_START: IsoTimestamp = '2026-05-12T09:00:00.000Z';

/** How far into a run one team has got. */
export interface SimulationClock {
  /** When the run began. Every timestamp in it is measured from here. */
  readonly startedAt: IsoTimestamp;
  /** How long this team has been playing, in whole seconds. */
  readonly elapsedSeconds: Seconds;
  /** The moment the team is at now, as the engine wants it written. */
  readonly now: IsoTimestamp;
}

/**
 * The moment `elapsedSeconds` after a start.
 *
 * A start nobody can read, or an elapsed time no date can hold, falls back to
 * the default start. The alternative is a `RangeError` thrown out of the
 * middle of a run over a number a caller typed into a request.
 */
export function clockAt(startedAt: IsoTimestamp, elapsedSeconds: Seconds): IsoTimestamp {
  const began = Date.parse(startedAt);
  if (Number.isNaN(began)) {
    return DEFAULT_SIMULATION_START;
  }
  const moment = began + Math.round(elapsedSeconds) * 1000;
  if (!Number.isFinite(moment) || Math.abs(moment) > 8.64e15) {
    return new Date(began).toISOString();
  }
  return new Date(moment).toISOString();
}

/** A clock at the beginning of a run. */
export function startClock(startedAt: IsoTimestamp = DEFAULT_SIMULATION_START): SimulationClock {
  return {
    startedAt: clockAt(startedAt, 0),
    elapsedSeconds: 0,
    now: clockAt(startedAt, 0),
  };
}

/**
 * The clock, moved forward.
 *
 * Never backwards: a negative or unreadable number of seconds moves it
 * nothing at all, because a stream whose timestamps step backwards is a
 * stream nobody can read as a story (EXPD-014).
 */
export function advanceClock(clock: SimulationClock, bySeconds: Seconds): SimulationClock {
  const by = Number.isFinite(bySeconds) && bySeconds > 0 ? Math.round(bySeconds) : 0;
  const elapsedSeconds = clock.elapsedSeconds + by;
  return {
    startedAt: clock.startedAt,
    elapsedSeconds,
    now: clockAt(clock.startedAt, elapsedSeconds),
  };
}

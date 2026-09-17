/**
 * Has the mission's clock run out? (EXPD-011)
 *
 * "Timer expired" is the sixth of the six ways a mission is completed, and
 * the only one that arrives with no submission behind it. A team opened a
 * timed mission, the time ran out, and nobody handed anything in.
 *
 * **The engine still holds no clock.** Nothing here reads `Date.now()`, for
 * the reason EXPD-010 gives: a function that reads the clock cannot be
 * replayed, and the simulation harness (EXPD-015) has to be able to run the
 * same expedition twice and get the same answer. Whoever owns the clock — the
 * API's session timer, the harness's own tick — passes the moment in, and
 * these functions do arithmetic on it.
 *
 * What they are for is the mistake at the other end. A caller holding a timer
 * can fire it early: a device clock that is wrong, a queue that ran late, a
 * job that woke twice. A mission put into `failed` with time still on it is
 * not something a team can argue with afterwards, so the completion interface
 * checks the arithmetic before it applies an `expire`, and refuses one that
 * has not come due.
 *
 * The mission's clock starts when the team opens the mission, because that is
 * what `MissionState.in-progress` means and what `timeLimitSeconds` counts
 * down in. The moment it started is not stored separately: it is in the
 * mission's own history, as the `at` of the `start` that opened the try.
 */

import type { IsoTimestamp, MissionProgress } from '@explorer/shared-types';

import type { MissionCompletionPolicy } from './policy.ts';

/**
 * When the team opened the try that is running now.
 *
 * The `at` of the last `start` in the mission's history. `undefined` when the
 * team has never opened it, and — because a mission that was handed back
 * keeps every line — the time of the *current* try rather than the first one.
 */
export function attemptStartedAt(
  progress: MissionProgress,
): IsoTimestamp | undefined {
  for (let index = progress.log.length - 1; index >= 0; index -= 1) {
    const entry = progress.log[index];
    if (entry?.trigger === 'start') {
      return entry.at;
    }
  }
  return undefined;
}

/**
 * Reads an ISO 8601 timestamp as a number of milliseconds.
 *
 * `undefined` when the string is not a time, so that a stored line nobody can
 * read stops the arithmetic rather than turning it into `NaN` comparisons
 * that are quietly false whichever way round they are asked.
 */
function millisecondsOf(at: IsoTimestamp): number | undefined {
  const parsed = Date.parse(at);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * When a running try runs out of time.
 *
 * `undefined` when the mission is not timed, when the team has not opened it,
 * or when the history holds a time nobody can read. Whoever owns the clock
 * asks this to know when to set a timer, and the completion interface asks it
 * to know whether one that has gone off was right to.
 */
export function missionDeadline(
  policy: MissionCompletionPolicy,
  progress: MissionProgress,
): IsoTimestamp | undefined {
  if (policy.timeLimitSeconds === null) {
    return undefined;
  }
  const startedAt = attemptStartedAt(progress);
  if (startedAt === undefined) {
    return undefined;
  }
  const started = millisecondsOf(startedAt);
  if (started === undefined) {
    return undefined;
  }
  const due = started + policy.timeLimitSeconds * 1000;
  if (!Number.isFinite(due) || Math.abs(due) > 8.64e15) {
    // A limit so long that no date can hold the answer is not a limit. The
    // alternative is a thrown RangeError from deep inside an arithmetic
    // helper, on the day a class is standing in a field.
    return undefined;
  }
  return new Date(due).toISOString();
}

/**
 * Whether the mission's own clock had run out by the moment given.
 *
 * True at the deadline itself, not only after it: a team whose time limit is
 * sixty seconds has sixty seconds, and the sixty-first is over.
 *
 * An untimed mission is never expired by this, and neither is one whose start
 * cannot be read. Both answer false, which leaves the expedition's own clock
 * (EXPD-019) as the only thing that can end them — which is right, because a
 * mission with no limit of its own has none.
 */
export function hasMissionExpired(
  policy: MissionCompletionPolicy,
  progress: MissionProgress,
  at: IsoTimestamp,
): boolean {
  const deadline = missionDeadline(policy, progress);
  if (deadline === undefined) {
    return false;
  }
  const now = millisecondsOf(at);
  const due = millisecondsOf(deadline);
  if (now === undefined || due === undefined) {
    return false;
  }
  return now >= due;
}

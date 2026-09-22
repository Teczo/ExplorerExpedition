/**
 * A mission's history, stored and read back (EXPD-020).
 *
 * The engine keeps where a team stands on a mission as a list of named
 * transitions (EXPD-010), and that list is the record: the state is only
 * ever the last line of it. So nothing here stores a state. Every line the
 * engine wrote is kept as a row of `mission_transition`, and a mission is
 * rebuilt by handing those rows back to `replayMissionTransitions` — which
 * checks each line against the rules as it goes, so a history that was
 * tampered with is caught on the next read rather than played on.
 *
 * The rules for the round trip are the ones `stream/rows.ts` uses, for the
 * same reason: a line read back has to be the line that was written.
 *
 *   - An absent `reason` is NULL, and NULL is an absent `reason`.
 *   - An empty `detail` and no `detail` are the same thing, because the
 *     column cannot hold an absent object.
 *   - A time is `timestamptz`, read back as ISO 8601 in UTC. A mission's own
 *     time limit is measured from its `start` line, so this is not cosmetic.
 */

import {
  createMissionProgress,
  replayMissionTransitions,
  type MissionStatePolicy,
} from '@explorer/engine';
import {
  toId,
  type MissionInstanceId,
  type MissionProgress,
  type MissionTransition,
} from '@explorer/shared-types';

import type { MissionTransitionRow } from '../repositories/rows.ts';

/** Thrown when a stored history is one the rules could not have produced. */
export class MissionHistoryError extends Error {
  override readonly name = 'MissionHistoryError';

  constructor(teamId: string, missionInstanceId: string, index: number, message: string) {
    super(
      `The stored history of mission ${missionInstanceId} for team ${teamId} does ` +
        `not replay: line ${String(index + 1)} — ${message} Nothing was changed.`,
    );
  }
}

/** The line a row was written from. */
export function toMissionTransition(row: MissionTransitionRow): MissionTransition {
  const detail =
    row.detail !== null && Object.keys(row.detail).length > 0 ? row.detail : undefined;
  return {
    from: row.from_state,
    to: row.to_state,
    trigger: row.trigger,
    actor: row.actor,
    at: asDate(row.occurred_at).toISOString(),
    attemptNumber: row.attempt_number,
    ...(row.reason === null ? {} : { reason: row.reason }),
    ...(detail === undefined ? {} : { detail }),
  };
}

/** The columns a line is written into, apart from the ones the caller owns. */
export function missionTransitionColumns(
  transition: MissionTransition,
): Record<string, unknown> {
  return {
    from_state: transition.from,
    to_state: transition.to,
    trigger: transition.trigger,
    actor: transition.actor,
    attempt_number: transition.attemptNumber,
    reason: transition.reason ?? null,
    detail: transition.detail ?? {},
    occurred_at: new Date(transition.at),
  };
}

/**
 * Every mission a team has a history for, rebuilt and checked.
 *
 * The rows come in the team's own order, `sequence` ascending. A mission with
 * no rows has no entry: it is `locked`, and `createMissionProgress` is what a
 * caller reaches for.
 *
 * @throws MissionHistoryError when a history does not replay. That is a
 * record somebody changed, and playing on from it would build on a lie.
 */
export function rebuildMissions(
  teamId: string,
  rows: readonly MissionTransitionRow[],
  policyFor: (missionInstanceId: MissionInstanceId) => MissionStatePolicy,
): Map<MissionInstanceId, MissionProgress> {
  const lines = new Map<MissionInstanceId, MissionTransition[]>();
  for (const row of [...rows].sort((one, other) => one.sequence - other.sequence)) {
    const key = toId<'missionInstance'>(row.mission_instance_key);
    const list = lines.get(key);
    if (list === undefined) {
      lines.set(key, [toMissionTransition(row)]);
    } else {
      list.push(toMissionTransition(row));
    }
  }

  const missions = new Map<MissionInstanceId, MissionProgress>();
  for (const [missionInstanceId, history] of lines) {
    const replayed = replayMissionTransitions(
      createMissionProgress(missionInstanceId),
      history,
      policyFor(missionInstanceId),
    );
    if (!replayed.consistent) {
      throw new MissionHistoryError(teamId, missionInstanceId, replayed.index, replayed.message);
    }
    missions.set(missionInstanceId, replayed.progress);
  }
  return missions;
}

/** A `timestamptz` as a `Date`, whatever the driver handed back. */
function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

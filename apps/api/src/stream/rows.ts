/**
 * Turning a sealed line into a row, and a row back into the same line
 * (EXPD-014).
 *
 * This is the only file in the API that is allowed to be fussy, and it has to
 * be. The seal on a line is taken over the engine's event, so a row that
 * cannot be read back as *exactly* that event cannot be checked against its
 * own seal — and a record nobody can check is not a record. "Exactly" here
 * means what `canonicalJson` means by it: the same fields, present or absent,
 * with the same values.
 *
 * Which is why every field of a `ScoreEvent` and a `ProgressionEvent` has a
 * column of its own rather than a share of `metadata`. Migration 0004 added
 * the four that 0001 had nowhere for — the mission and hint as the document
 * ids the engine actually uses, which try it was, and what a cap or a floor
 * trimmed — for this reason and no other.
 *
 * Three round trips are not quite free, and the rule for each is here rather
 * than spread over the writer and the reader:
 *
 *   - **An absent field is NULL, and NULL is an absent field.** Never an
 *     empty string and never nought, because `note: ''` and no note are two
 *     different lines and seal differently.
 *   - **`detail` and `{}` are the same thing.** The column cannot hold an
 *     absent object — 0001 gives it `NOT NULL DEFAULT '{}'` — so a `detail`
 *     with nothing in it is normalised away on the way in, before the line is
 *     sealed. `normaliseScoreEvent` is what does it, and everything seals
 *     through it.
 *   - **A time is stored as `timestamptz` and read back as ISO 8601 in UTC**,
 *     which is what `IsoTimestamp` promises and what `Date#toISOString`
 *     gives. A time the engine was handed in another offset comes back as the
 *     same instant written the way the schema writes one.
 */

import type {
  IsoTimestamp,
  JsonObject,
  ProgressionEvent,
  ScoreEvent,
} from '@explorer/shared-types';
import { toId } from '@explorer/shared-types';

import type { ProgressionEventRow, ScoreEventRow } from '../repositories/rows.ts';

/** An object with nothing in it is the same as no object at all. */
function detailOf(metadata: JsonObject): JsonObject | undefined {
  return Object.keys(metadata).length === 0 ? undefined : metadata;
}

/** The time a row carries, as the ISO 8601 string in UTC the engine reads. */
function timeOf(occurredAt: Date): IsoTimestamp {
  return occurredAt.toISOString();
}

/**
 * A score event with nothing on it that a row could not carry back.
 *
 * Everything seals through this, so that a line is sealed over the same
 * fields the database will hand back and not over a `detail: {}` the column
 * has no way to distinguish from no detail at all.
 */
export function normaliseScoreEvent(event: ScoreEvent): ScoreEvent {
  if (event.detail === undefined || Object.keys(event.detail).length > 0) {
    return event;
  }
  const { detail: _dropped, ...rest } = event;
  return rest;
}

/** The same, for a progression event. */
export function normaliseProgressionEvent(event: ProgressionEvent): ProgressionEvent {
  if (event.detail === undefined || Object.keys(event.detail).length > 0) {
    return event;
  }
  const { detail: _dropped, ...rest } = event;
  return rest;
}

/** The columns a score line is written into, apart from the ones the caller owns. */
export function scoreEventColumns(event: ScoreEvent): Record<string, unknown> {
  const normalised = normaliseScoreEvent(event);
  return {
    reason: normalised.reason,
    points: normalised.points,
    occurred_at: new Date(normalised.at),
    mission_instance_key: normalised.missionInstanceId ?? null,
    hint_key: normalised.hintId ?? null,
    scoring_rule_key: normalised.scoringRuleId ?? null,
    attempt_number: normalised.attemptNumber ?? null,
    note: normalised.note ?? null,
    limit_kind: normalised.limit?.kind ?? null,
    limit_would_have_been: normalised.limit?.wouldHaveBeen ?? null,
    metadata: normalised.detail ?? {},
  };
}

/** The columns a progression line is written into. */
export function progressionEventColumns(
  event: ProgressionEvent,
): Record<string, unknown> {
  const normalised = normaliseProgressionEvent(event);
  return {
    reason: normalised.reason,
    occurred_at: new Date(normalised.at),
    node_key: normalised.nodeId ?? null,
    mission_instance_key: normalised.missionInstanceId ?? null,
    note: normalised.note ?? null,
    metadata: normalised.detail ?? {},
  };
}

/**
 * The score event a row was written from.
 *
 * Sealing this again gives the row's own `hash` back, and `verifyStream`
 * saying otherwise means somebody changed the row.
 */
export function toScoreEvent(row: ScoreEventRow): ScoreEvent {
  const detail = detailOf(row.metadata);
  return {
    reason: row.reason,
    points: row.points,
    at: timeOf(row.occurred_at),
    ...(row.mission_instance_key === null
      ? {}
      : { missionInstanceId: toId<'missionInstance'>(row.mission_instance_key) }),
    ...(row.hint_key === null ? {} : { hintId: toId<'hint'>(row.hint_key) }),
    ...(row.scoring_rule_key === null
      ? {}
      : { scoringRuleId: toId<'scoringRule'>(row.scoring_rule_key) }),
    ...(row.attempt_number === null ? {} : { attemptNumber: row.attempt_number }),
    ...(row.note === null ? {} : { note: row.note }),
    ...(row.limit_kind === null || row.limit_would_have_been === null
      ? {}
      : { limit: { kind: row.limit_kind, wouldHaveBeen: row.limit_would_have_been } }),
    ...(detail === undefined ? {} : { detail }),
  };
}

/** The progression event a row was written from, for the same reason. */
export function toProgressionEvent(row: ProgressionEventRow): ProgressionEvent {
  const detail = detailOf(row.metadata);
  return {
    reason: row.reason,
    at: timeOf(row.occurred_at),
    ...(row.node_key === null ? {} : { nodeId: toId<'node'>(row.node_key) }),
    ...(row.mission_instance_key === null
      ? {}
      : { missionInstanceId: toId<'missionInstance'>(row.mission_instance_key) }),
    ...(row.note === null ? {} : { note: row.note }),
    ...(detail === undefined ? {} : { detail }),
  };
}

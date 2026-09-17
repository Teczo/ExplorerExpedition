/**
 * One line of the record of where a team got to (EXPD-014).
 *
 * A `ProgressionSnapshot` says where a team stands *now*. It is worked out
 * again from scratch every time it is asked for, and nothing stores one. That
 * is the right answer for a mission board, and the wrong one for an argument
 * a fortnight later: "the app never showed us mission four" cannot be settled
 * by working out what the app would show today, because the graph, the
 * team's records and the clock have all moved on since.
 *
 * So the moments the snapshot changed are written down as they happen, in the
 * same shape a `ScoreEvent` is. Between them the two make one stream: what a
 * team was allowed to do, and what it earned them.
 *
 * A line is about one team, and it does not say which team, for the reason
 * `ScoreEvent` and `MissionTransition` both give: whatever stores one already
 * knows whose it is, and repeating it here would be a second place for it to
 * be wrong.
 */

import type {
  IsoTimestamp,
  JsonObject,
  MissionInstanceId,
  NodeId,
} from '../expedition/common.ts';

/** What changed about where a team stands. */
export type ProgressionEventReason =
  /** An edge let the team through to a stop they had not been to. */
  | 'node-reached'
  /**
   * A stop stopped holding the way up.
   *
   * A start or a checkpoint clears the moment it is reached. A mission stop
   * clears when its mission is over — finished, failed or skipped — or at
   * once when the author marked it optional.
   */
  | 'node-cleared'
  /** The lock came off a mission, so the team could work on it. */
  | 'mission-unlocked'
  /** A secret mission stopped being secret, so the team could see it at all. */
  | 'mission-revealed'
  /** The team reached a finish node, which ends the expedition for them. */
  | 'expedition-finished';

/** Every reason, in the order they are listed above. */
export const PROGRESSION_EVENT_REASONS = [
  'node-reached',
  'node-cleared',
  'mission-unlocked',
  'mission-revealed',
  'expedition-finished',
] as const satisfies readonly ProgressionEventReason[];

/** Says whether a string is one of the reasons above. */
export function isProgressionEventReason(
  value: unknown,
): value is ProgressionEventReason {
  return (
    typeof value === 'string' &&
    (PROGRESSION_EVENT_REASONS as readonly string[]).includes(value)
  );
}

/** One change to where a team stands on the graph. */
export interface ProgressionEvent {
  /** What changed. */
  readonly reason: ProgressionEventReason;
  /**
   * When the engine decided it.
   *
   * Passed in by the caller, the same way a `ScoreEvent`'s `at` is, because
   * the engine holds no clock. It is when the change was worked out rather
   * than when a phone noticed it, so lines read in order even though the
   * events behind them did not arrive in order.
   */
  readonly at: IsoTimestamp;
  /**
   * The stop it was about.
   *
   * On `node-reached`, `node-cleared` and `expedition-finished`. On the two
   * mission reasons it is the stop that holds the mission, so that a reader
   * can place the line on the graph without the document to hand.
   */
  readonly nodeId?: NodeId;
  /** The mission it was about. On `mission-unlocked` and `mission-revealed`. */
  readonly missionInstanceId?: MissionInstanceId;
  /**
   * Why, in a sentence a person can read.
   *
   * What a team is shown on their board (EXPD-042), and what a dispute is
   * answered with.
   */
  readonly note?: string;
  /**
   * Anything the caller wants kept with the line.
   *
   * Stored and handed back. The engine does not read it, the same way it does
   * not read a `ScoreEvent`'s `detail`.
   */
  readonly detail?: JsonObject;
}

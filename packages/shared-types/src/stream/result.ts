/**
 * A final result, rebuilt from the record behind it (EXPD-014).
 *
 * This is what the ticket asks for in one value: everything a team ended on,
 * worked out from their stream and from nothing else. No document is read, no
 * rule is applied, no other team is consulted and no clock is needed. Hand
 * the same lines to the same function on any machine, a fortnight or a year
 * later, and the same result comes out — which is what makes it something to
 * settle an argument with rather than something to be told.
 *
 * **It is a reading of the record, not a second opinion about it.** Every
 * figure here is arithmetic over lines that were written at the time. Whether
 * those lines were the right ones to write is the scoring engine's question
 * (EXPD-012) and the progression engine's (EXPD-013), and re-running either
 * against a stream is the simulation harness (EXPD-015).
 *
 * **What it cannot say, it does not say.** The streak, the failed attempts
 * and the hints spent are not in the stream — `TeamScore` explains why — so
 * they are not here. Neither is the team's place in the field, which is
 * EXPD-022 and is a fact about every other team.
 */

import type {
  IsoTimestamp,
  MissionInstanceId,
  NodeId,
} from '../expedition/common.ts';
import type { ScoreEventReason } from '../scoring/reason.ts';

/** What one mission came to for a team. */
export interface MissionResult {
  readonly missionInstanceId: MissionInstanceId;
  /** The sum of every score line that named this mission. */
  readonly points: number;
  /** How many score lines named it, whether they added or took away. */
  readonly lines: number;
  /** Whether the lock ever came off it. */
  readonly unlocked: boolean;
  /** Whether the team was ever shown it. */
  readonly revealed: boolean;
  /** When the first line about it was written. */
  readonly firstAt?: IsoTimestamp;
  /** When the last one was. */
  readonly lastAt?: IsoTimestamp;
}

/** What a team's stream comes to. */
export interface StreamResult {
  /**
   * The team's final total.
   *
   * The sum of every score line, and nothing else. It is the figure
   * `team.total_score` caches, and the one a dispute is about.
   */
  readonly total: number;
  /**
   * What each reason was worth, added up.
   *
   * The answer to "where did 340 come from" in ten numbers. A reason no line
   * carried is absent rather than nought, so the list is the reasons that
   * actually moved this team.
   */
  readonly pointsByReason: Readonly<Partial<Record<ScoreEventReason, number>>>;
  /**
   * What each mission was worth, in the order the stream first named them.
   *
   * The answer to "why does mission four show 40", which is the argument a
   * class actually has.
   */
  readonly missions: readonly MissionResult[];
  /** The stops the team reached, in the order they reached them. */
  readonly reachedNodeIds: readonly NodeId[];
  /** The stops that stopped holding the way up, in the order they cleared. */
  readonly clearedNodeIds: readonly NodeId[];
  /** The missions the lock came off, in the order it came off them. */
  readonly unlockedMissionIds: readonly MissionInstanceId[];
  /** Every mission the team was ever shown, in the order they saw them. */
  readonly revealedMissionIds: readonly MissionInstanceId[];
  /** Whether the team reached a finish node. */
  readonly finished: boolean;
  /** When they did, when they did. */
  readonly finishedAt?: IsoTimestamp;
  /** How many lines the stream holds. */
  readonly lines: number;
  /** When the first line was written. */
  readonly startedAt?: IsoTimestamp;
  /** When the last one was. */
  readonly endedAt?: IsoTimestamp;
}

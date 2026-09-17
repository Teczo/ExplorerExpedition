/**
 * One line of the record of a team's score (EXPD-012).
 *
 * Every time a team's score moves, one of these says by how much and why. It
 * is the same relationship the mission's history (EXPD-010) has with its
 * state: the total is what every read wants, and the stream is what makes the
 * total something anybody can check rather than something they have to trust.
 * Migration 0001 says the same thing of the two columns — `score_event` is
 * the record and `team.total_score` is a total kept alongside it — and adding
 * up a team's events gives that column back.
 *
 * **`points` is what actually moved the total**, not what a rule asked for. A
 * mission's `maxPoints` cap and the expedition's `minimumTotal` floor can
 * both trim an award on its way in, and when one does, `limit` says which and
 * what the untrimmed figure would have been. Recording the trimmed figure is
 * what keeps the stream addable: a reader adds up `points` and lands on the
 * team's total without having to know a single scoring rule.
 *
 * A line is about one team, and it does not say which team, for the reason
 * `MissionTransition` gives: whatever stores one — a row, a realtime frame
 * (EXPD-023), a simulation run (EXPD-015) — already knows whose it is, and
 * repeating it here would be a second place for it to be wrong. For the same
 * reason there is no attempt id, submission id or participant id on it: those
 * belong to rows the engine has never seen, and EXPD-020 is what fills the
 * matching columns in when it writes one down.
 *
 * Carrying the stream across the system — storing it, ordering it, proving
 * nothing edited it — is EXPD-014. This is the value that stream is made of.
 */

import type {
  HintId,
  IsoTimestamp,
  JsonObject,
  MissionInstanceId,
  ScoringRuleId,
} from '../expedition/common.ts';
import type { ScoreEventReason } from './reason.ts';

/** What trimmed an award on its way in. */
export type ScoreLimitKind =
  /** `MissionScoring.maxPoints`: the most that mission can ever be worth. */
  | 'mission-cap'
  /** `ScoringConfig.minimumTotal`: the lowest score a team can end on. */
  | 'minimum-total';

/** An award a limit cut down before it reached the total. */
export interface ScoreLimit {
  /** Which of the two limits did it. */
  readonly kind: ScoreLimitKind;
  /** What the award would have been had the limit not been there. */
  readonly wouldHaveBeen: number;
}

/** One change to a team's score. */
export interface ScoreEvent {
  /** Why the score moved. */
  readonly reason: ScoreEventReason;
  /**
   * How much it moved by. Positive for points earned, negative for points
   * taken away, and never zero — a score that did not move is not an event.
   */
  readonly points: number;
  /**
   * When the engine decided it.
   *
   * Passed in by the caller, the same way a transition's `at` is, because the
   * engine holds no clock.
   */
  readonly at: IsoTimestamp;
  /** The mission it was for, when it was for one. */
  readonly missionInstanceId?: MissionInstanceId;
  /** The hint it was for. Only ever on a `hint-penalty`. */
  readonly hintId?: HintId;
  /**
   * The rule that caused it, as the definition document ids it.
   *
   * Present on every reason a rule causes, and absent on the three no rule
   * does. It is the document's own id rather than a database key, which is
   * what `score_event.scoring_rule_key` holds too.
   */
  readonly scoringRuleId?: ScoringRuleId;
  /** Which try it was about, counting from one. Absent when it was not one. */
  readonly attemptNumber?: number;
  /**
   * Why, in a sentence a person can read.
   *
   * What a team is shown on their score screen (EXPD-045), and a teacher's
   * own words on a `manual-adjustment`.
   */
  readonly note?: string;
  /** What cut the award down, when something did. */
  readonly limit?: ScoreLimit;
  /**
   * Anything the caller wants kept with the line.
   *
   * Stored and handed back. The engine does not read it, the same way it does
   * not read a behaviour's `detail` (EXPD-009).
   */
  readonly detail?: JsonObject;
}

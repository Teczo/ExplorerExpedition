/**
 * Where one team stands on points (EXPD-012).
 *
 * The total, the few running counts the rules need to work out the next
 * award, and every change that got the team there. It is the scoring engine's
 * `MissionProgress`: a plain value, nothing in it is a method, it survives a
 * round trip through JSON, and the engine hands back a new one rather than
 * editing the one it was given.
 *
 * **The counts are not all rebuildable from the stream, and that is on
 * purpose.** Adding up `events` gives `total` back exactly, because every
 * event records what actually moved the total. The streak, the wrong answers
 * and the hints spent are not in the stream, because an answer that cost the
 * team nothing writes no event and still breaks a streak. They are the
 * engine's running state, rebuilt by replaying the game rather than the
 * score, and stored beside the total by whoever stores it. `team` in
 * migration 0001 already keeps `total_score` and `hint_tokens_remaining` that
 * way.
 *
 * It is not a database row and it holds no team id, for the reason
 * `ScoreEvent` gives.
 */

import type { HintId, MissionInstanceId, ScoringRuleId } from '../expedition/common.ts';
import type { ScoreEvent } from './event.ts';

/** Where one team stands on points. */
export interface TeamScore {
  /**
   * The team's score now.
   *
   * Always the sum of `events`, and never below the expedition's
   * `minimumTotal` once one has been applied.
   */
  readonly total: number;
  /**
   * The missions this team has finished, oldest first.
   *
   * A finished mission is paid for once and never again. Two phones on one
   * team both landing the same verdict, or a queued submission (EXPD-048)
   * arriving twice, is answered from this list rather than paid for twice. A
   * wrong answer is not in it, because a team handed the mission back may get
   * it wrong again and that is a second wrong answer rather than the same
   * one. Its length is what the `most-missions-completed` tie break
   * (EXPD-022) reads.
   */
  readonly completedMissionIds: readonly MissionInstanceId[];
  /**
   * The hints this team has already paid for, oldest first.
   *
   * The same guard as above, for the same reason. Its length is what the
   * `fewest-hints-used` tie break reads.
   */
  readonly spentHintIds: readonly HintId[];
  /**
   * The rules that pay out once and already have.
   *
   * Only a `completion-bonus` is in here: every other rule either pays per
   * mission, which `scoredMissionIds` already guards, or pays again each time
   * its condition comes round.
   */
  readonly awardedRuleIds: readonly ScoringRuleId[];
  /**
   * How many missions the team has finished in a row without a failure.
   *
   * What a `streak-bonus` counts. A wrong answer or a mission that timed out
   * puts it back to nought.
   */
  readonly streak: number;
  /** The longest run of those the team has managed. Shown at the end. */
  readonly longestStreak: number;
  /**
   * How many answers the team has got wrong.
   *
   * What the `fewest-failed-attempts` tie break reads. A mission that timed
   * out is not a wrong answer and is not counted here, though it does break a
   * streak: nobody answered anything.
   */
  readonly failedAttempts: number;
  /**
   * Every score change, oldest first.
   *
   * Adding up their `points` gives `total`. Keeping both is a duplicate on
   * purpose, the same one `MissionProgress` keeps.
   */
  readonly events: readonly ScoreEvent[];
}

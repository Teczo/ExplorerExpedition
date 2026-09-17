/**
 * What one check of a team's work concluded (EXPD-011).
 *
 * One of these comes back every time the completion interface looks at
 * something: a submission, a teacher's decision, a clock running out. It says
 * what was concluded, what concluded it, which trigger that became, and what
 * to show the team.
 *
 * It is a plain value and it survives a round trip through JSON, the same way
 * `MissionProgress` does, because it is sent down the realtime channel
 * (EXPD-023) and shown on a phone. Two things read it next: the scoring
 * engine (EXPD-012) turns an outcome into points, and the review queue
 * (EXPD-056) lists everything whose `review` is not `none`.
 *
 * A verdict is not a mission state. The state is what the transition the
 * verdict carries left the mission in, and the mission's own history
 * (EXPD-010) is the record of that. This says why.
 */

import type { JsonObject } from '../expedition/common.ts';
import type { MissionTrigger } from '../mission-state/triggers.ts';
import type {
  CompletionMethod,
  CompletionOutcome,
  CompletionReview,
} from './outcome.ts';

/** What one check of a team's work concluded. */
export interface CompletionVerdict {
  /** What was concluded. */
  readonly outcome: CompletionOutcome;
  /** What concluded it. */
  readonly method: CompletionMethod;
  /**
   * The trigger the verdict became.
   *
   * `accept`, `reject`, `refer`, `verify`, `overrule` or `expire`. It is the
   * one the state machine was given, so a caller never has to work out for
   * itself which trigger an outcome maps to — doing that twice, in two
   * places, is how the two would come to disagree.
   */
  readonly trigger: MissionTrigger;
  /** Whether a person still has to look at this. */
  readonly review: CompletionReview;
  /**
   * How much of the mission is done, from 0 to 1.
   *
   * Only present when the mission type says. The scoring engine (EXPD-012) is
   * what decides whether partial progress is worth anything.
   */
  readonly progress?: number;
  /** What to show the team. Never says the answer. */
  readonly feedback?: string;
  /**
   * Why, in a sentence, when there is more to say than the outcome.
   *
   * A teacher's note, which clock ran out, or that the mission type had no
   * code to judge with. It is written into the mission's history as the
   * transition's `reason`, so the history says why as well as what.
   */
  readonly reason?: string;
  /**
   * Whatever the mission type kept with the attempt.
   *
   * Stored and handed back. The engine does not read it, the same way it does
   * not read a behaviour's `detail` (EXPD-009).
   */
  readonly detail?: JsonObject;
}

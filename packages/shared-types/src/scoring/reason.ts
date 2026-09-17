/**
 * Why a team's score moved (EXPD-012).
 *
 * Ten words, and they are the `score_event_reason` enum from migration 0001
 * value for value. A score change is never written down as free text: it says
 * which of these ten it was, so that Director Mode (EXPD-055), the results
 * screen (EXPD-059) and a parent asking why a team finished on 340 all read
 * the same word for the same thing.
 *
 * Seven of the ten are the seven scoring rule types (EXPD-002), and they line
 * up on purpose: a rule that fires writes an event named after itself, and
 * `scoringRuleId` on the event says which rule of that type it was. The other
 * three are the ones no rule causes — finishing a mission, finishing part of
 * one, and a teacher moving the score by hand (EXPD-058).
 */

/** Why a team's score moved. */
export type ScoreEventReason =
  /** The team finished a mission and earned what it is worth. */
  | 'mission-complete'
  /**
   * The team got part of a mission right and earned part of its points.
   *
   * Only ever written when the mission's `allowPartialCredit` is on and the
   * mission type said how much of it was done.
   */
  | 'partial-credit'
  /** They beat the time a `speed-bonus` rule set. */
  | 'speed-bonus'
  /** They were the first team to finish a mission a rule named. */
  | 'first-to-complete-bonus'
  /** They finished enough missions in a row without a failure. */
  | 'streak-bonus'
  /** They finished every mission a `completion-bonus` rule named. */
  | 'completion-bonus'
  /** They spent a token on a hint, and a rule charges for that. */
  | 'hint-penalty'
  /** They answered a mission wrongly, and a rule charges for that. */
  | 'attempt-penalty'
  /** They finished after the expedition's clock, past the grace period. */
  | 'late-penalty'
  /** A teacher moved the score by hand (EXPD-058). */
  | 'manual-adjustment';

/** Every reason, in the order they are listed above. */
export const SCORE_EVENT_REASONS = [
  'mission-complete',
  'partial-credit',
  'speed-bonus',
  'first-to-complete-bonus',
  'streak-bonus',
  'completion-bonus',
  'hint-penalty',
  'attempt-penalty',
  'late-penalty',
  'manual-adjustment',
] as const satisfies readonly ScoreEventReason[];

/** Says whether a string is one of the reasons above. */
export function isScoreEventReason(value: unknown): value is ScoreEventReason {
  return (
    typeof value === 'string' &&
    (SCORE_EVENT_REASONS as readonly string[]).includes(value)
  );
}

/**
 * Work the completion interface would not check (EXPD-011).
 *
 * A refusal is an ordinary answer, the same way a refused transition is
 * (EXPD-010). A team that hands in work from the wrong end of the park, a
 * phone replaying a queued submission after the mission timed out
 * (EXPD-048), a second tap on submit — all of those are a team playing
 * normally. None of them is an error, none of them is judged, and none of
 * them changes the mission or its history.
 *
 * The difference between a refusal and an `incorrect` verdict matters and is
 * the reason this file exists. A wrong answer is a try spent and a thing the
 * scoring engine (EXPD-012) may take points for. Work that was never checked
 * is neither.
 */

import type { IsoTimestamp } from '../expedition/common.ts';
import type { MissionConfigIssue } from '../mission-type/issues.ts';
import type { MissionTransitionRefusal } from '../mission-state/transition.ts';

/** Why work was not checked. */
export type CompletionRefusalCode =
  /**
   * The state machine would not take it (EXPD-010).
   *
   * The mission has already finished, has not been opened, or is already
   * waiting on somebody. `stateRefusal` carries which of those it was.
   */
  | 'not-now'
  /** The mission names a type nothing has registered (EXPD-009). */
  | 'unknown-mission-type'
  /** The payload is not the shape the mission type's submission schema sets. */
  | 'invalid-submission'
  /** The team is outside the area the mission says they have to be in. */
  | 'wrong-place'
  /**
   * The device could not say where it was well enough, and the mission blocks
   * on that (`LocationConstraint.onPoorAccuracy`).
   */
  | 'poor-accuracy'
  /**
   * The mission's own clock has not run out yet.
   *
   * Only an expiry is refused this way. It is the guard against a timer that
   * fired early putting a team's mission into `failed` with time still on it.
   */
  | 'not-yet-expired';

/** Every refusal code, in the order they are listed above. */
export const COMPLETION_REFUSAL_CODES = [
  'not-now',
  'unknown-mission-type',
  'invalid-submission',
  'wrong-place',
  'poor-accuracy',
  'not-yet-expired',
] as const satisfies readonly CompletionRefusalCode[];

/** Says whether a string is one of the codes above. */
export function isCompletionRefusalCode(
  value: unknown,
): value is CompletionRefusalCode {
  return (
    typeof value === 'string' &&
    (COMPLETION_REFUSAL_CODES as readonly string[]).includes(value)
  );
}

/** Work the completion interface would not check. */
export interface CompletionRefusal {
  readonly code: CompletionRefusalCode;
  /** A sentence a person can read. */
  readonly message: string;
  /** Why the state machine refused. Present on `not-now` and nowhere else. */
  readonly stateRefusal?: MissionTransitionRefusal;
  /**
   * What is wrong with the payload, field by field.
   *
   * Present on `invalid-submission`. The paths are the same shape the
   * Expedition Definition (EXPD-002) and the mission type registry
   * (EXPD-009) report, so one form puts a problem from any of the three next
   * to the field it belongs to.
   */
  readonly issues?: MissionConfigIssue[];
  /**
   * How far the team is from the middle of the mission's area, in metres.
   *
   * Present on `wrong-place`, so the app can say how far there is to go
   * without being told where the answer is.
   */
  readonly metresAway?: number;
  /**
   * When the mission's clock actually runs out.
   *
   * Present on `not-yet-expired`, so whoever holds the clock can set it again
   * for the right moment rather than guessing.
   */
  readonly expiresAt?: IsoTimestamp;
}

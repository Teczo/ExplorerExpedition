/**
 * A score change the rules would not make (EXPD-012).
 *
 * A refusal is an ordinary answer, the same way a refused transition
 * (EXPD-010) and unchecked work (EXPD-011) are. Two phones on one team both
 * landing the same verdict, a submission queued offline (EXPD-048) replaying
 * after the mission was scored, a team tapping a hint twice while the first
 * tap is still in the air — all of those are a team playing normally, and
 * paying for any of them twice is the one thing a score stream must never do.
 * A refused change writes no event, moves no total and leaves every count
 * where it was.
 *
 * A refusal is not the same as a change worth nothing. A wrong answer on an
 * expedition with no `attempt-penalty` rule writes no event either, but it
 * does break the team's streak, so it is applied with an empty list of
 * events rather than refused.
 */

import type { HintId, MissionInstanceId } from '../expedition/common.ts';

/** Why a score change was not made. */
export type ScoreRefusalCode =
  /**
   * Nobody has decided yet, so there is nothing to pay for.
   *
   * A `needs-review` verdict: the mission is waiting on a teacher
   * (EXPD-056), and their decision arrives later as its own verdict.
   */
  | 'not-decided'
  /** This mission has already been scored for this team. */
  | 'already-scored'
  /** This hint has already been paid for. */
  | 'hint-already-spent';

/** Every refusal code, in the order they are listed above. */
export const SCORE_REFUSAL_CODES = [
  'not-decided',
  'already-scored',
  'hint-already-spent',
] as const satisfies readonly ScoreRefusalCode[];

/** Says whether a string is one of the codes above. */
export function isScoreRefusalCode(value: unknown): value is ScoreRefusalCode {
  return (
    typeof value === 'string' &&
    (SCORE_REFUSAL_CODES as readonly string[]).includes(value)
  );
}

/** A score change the rules would not make. */
export interface ScoreRefusal {
  readonly code: ScoreRefusalCode;
  /** A sentence a person can read. */
  readonly message: string;
  /** The mission it was about. Absent only when the change was not about one. */
  readonly missionInstanceId?: MissionInstanceId;
  /** The hint it was about. Present on `hint-already-spent` and nowhere else. */
  readonly hintId?: HintId;
}

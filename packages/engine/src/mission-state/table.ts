/**
 * The transition table (EXPD-010).
 *
 * One row per trigger: which states it may be applied in, and where it leaves
 * the mission. This is the whole of the state machine's shape. There is no
 * second place a mission state changes, no branch elsewhere that nudges one,
 * and nothing in the engine writes a state that did not come out of this
 * table — which is what the ticket means by every transition being explicit.
 *
 * The table is written as data rather than as a `switch` so that it can be
 * read as a table: the eleven rows below are the diagram somebody would draw
 * on a whiteboard, in the same order the triggers are listed in
 * `@explorer/shared-types`. Walking it is `machine.ts`.
 *
 * ```text
 *   locked  ──unlock──▶  available          available  ──relock──▶  locked
 *   available  ──start──▶  in-progress
 *   in-progress  ──submit──▶  submitted     in-progress  ──expire──▶  failed
 *   submitted  ──accept──▶  complete
 *   submitted  ──refer──▶  awaiting-verification
 *   submitted  ──reject──▶  available, or failed on the last try
 *   awaiting-verification  ──verify──▶  complete
 *   awaiting-verification  ──overrule──▶  available, or failed on the last try
 *   available, in-progress  ──skip──▶  skipped
 * ```
 *
 * `awaiting-verification` leaves the same two ways a judged submission does,
 * under a teacher's hand rather than the engine's: `verify` to `complete`,
 * `overrule` back for another go or to `failed`.
 *
 * Three things this table deliberately does not have:
 *
 *   1. **No edge out of a terminal state.** `complete`, `failed` and
 *      `skipped` are the end. Putting a team back into a mission a teacher
 *      has already closed is a live override (EXPD-058), and that ticket can
 *      add its own trigger and say in the log that a person did it.
 *   2. **No way back out of `in-progress` but finishing, timing out or
 *      skipping.** A team that opens a mission and wanders off has used a
 *      try. Letting them hand it back would make `max_attempts` mean nothing.
 *   3. **No edge that decides anything.** Whether a submission was right is
 *      EXPD-011, whether an unlock condition holds is EXPD-013, and what an
 *      outcome is worth is EXPD-012. Each of those hands the machine a
 *      trigger; none of them is run from here.
 */

import type { MissionState, MissionTrigger } from '@explorer/shared-types';

/** One row of the table: where a trigger may be applied, and where it goes. */
export interface MissionTransitionRule {
  /** The states the trigger may be applied in. */
  readonly from: readonly MissionState[];
  /** Where the mission goes. */
  readonly to: MissionState;
  /**
   * Where it goes instead when the team has no try left.
   *
   * Set only on the two triggers that hand a mission back for another go. A
   * wrong answer on the last allowed try is the end of the mission, not an
   * invitation to press start on something that would be refused.
   */
  readonly whenNoAttemptsLeft?: MissionState;
  /** The trigger opens a new try, so the attempt policy has to allow one. */
  readonly opensAttempt?: true;
  /** The trigger only works when the expedition's rules allow skipping. */
  readonly needsSkipAllowed?: true;
}

/**
 * Every transition the engine will make, by trigger.
 *
 * Adding a row here is adding an edge to the game, so it belongs to a ticket
 * that says what the edge is for.
 */
export const MISSION_TRANSITIONS: Readonly<Record<MissionTrigger, MissionTransitionRule>> = {
  unlock: { from: ['locked'], to: 'available' },
  relock: { from: ['available'], to: 'locked' },
  start: { from: ['available'], to: 'in-progress', opensAttempt: true },
  submit: { from: ['in-progress'], to: 'submitted' },
  accept: { from: ['submitted'], to: 'complete' },
  reject: { from: ['submitted'], to: 'available', whenNoAttemptsLeft: 'failed' },
  refer: { from: ['submitted'], to: 'awaiting-verification' },
  verify: { from: ['awaiting-verification'], to: 'complete' },
  overrule: {
    from: ['awaiting-verification'],
    to: 'available',
    whenNoAttemptsLeft: 'failed',
  },
  expire: { from: ['in-progress'], to: 'failed' },
  skip: { from: ['available', 'in-progress'], to: 'skipped', needsSkipAllowed: true },
};

/**
 * What goes wrong in the mission state machine (EXPD-010).
 *
 * There is one error here, and it is deliberately hard to reach. A transition
 * the rules will not make is an ordinary answer — `applyMissionTransition`
 * returns a refusal and changes nothing — because a team double-tapping
 * submit is a team playing, not a fault. This error is for the caller that
 * has already checked, the way `MissionTypeRegistry.require` is for the
 * caller that has already looked: if it throws, something upstream is wrong,
 * not something a student did.
 */

import type { MissionTransitionRefusal } from '@explorer/shared-types';

/** A transition was demanded, and the rules would not make it. */
export class MissionTransitionRefusedError extends Error {
  override readonly name = 'MissionTransitionRefusedError';

  /** Why it was refused, and what the mission is still doing. */
  readonly refusal: MissionTransitionRefusal;

  constructor(refusal: MissionTransitionRefusal) {
    super(refusal.message);
    this.refusal = refusal;
  }
}

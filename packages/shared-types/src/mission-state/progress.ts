/**
 * Where one team stands on one mission (EXPD-010).
 *
 * The state, how many tries have been used, and every change that got it
 * there. It is the whole of what the state machine knows about one mission,
 * and it is a plain value: nothing in it is a method, nothing in it is a
 * reference to a live object, and it survives a round trip through JSON. The
 * engine hands back a new one rather than editing the one it was given, so a
 * caller holding an old one still holds what it held.
 *
 * It is not a database row. `mission_attempt` (migration 0001) stores one try
 * and `submission` stores one answer; this is the view across all of them for
 * one mission. What builds one from stored rows is EXPD-020.
 */

import type { MissionInstanceId } from '../expedition/common.ts';
import type { MissionState } from './states.ts';
import type { MissionTransition } from './transition.ts';

/** Where one team stands on one mission. */
export interface MissionProgress {
  /** The mission this is about, as the definition document ids it. */
  readonly missionInstanceId: MissionInstanceId;
  /** Where it stands now. */
  readonly state: MissionState;
  /**
   * How many tries the team has opened, counting from zero.
   *
   * Only `start` moves it. A try is counted the moment it is opened rather
   * than when it is judged, so a team that opens a mission and lets the clock
   * run out has used one.
   */
  readonly attemptsUsed: number;
  /**
   * Every state change, oldest first.
   *
   * The state above is what replaying this list lands on. Keeping both is a
   * duplicate on purpose: the state is what every read wants, and the list is
   * what makes the state something anybody can check rather than something
   * they have to trust.
   */
  readonly log: readonly MissionTransition[];
}

/**
 * One line of a mission's history (EXPD-010).
 *
 * Every state change a mission makes is written down as one of these, and a
 * mission's state is never changed any other way. That is the second half of
 * what the ticket asks for: transitions are explicit, and they are logged.
 *
 * The log is not the audit log (EXPD-006) and not the score event stream
 * (EXPD-014). Those two answer "who changed this row" and "why does this team
 * have these points". This one answers "how did this mission get here", and
 * it is the record the engine itself replays: hand the same lines back to
 * `replayMissionTransitions` in `@explorer/engine` and the same state comes
 * out, or the replay says which line the rules disagree with.
 *
 * A line is about one mission for one team. It does not say which team,
 * because the engine holds no ids beyond the mission's own: whatever stores a
 * line — a row, a realtime frame, a simulation run — already knows whose it
 * is, and repeating it here would be a second place for it to be wrong.
 */

import type { IsoTimestamp, JsonObject } from '../expedition/common.ts';
import type { MissionState } from './states.ts';
import type { MissionTransitionActor, MissionTrigger } from './triggers.ts';

/** One state change a mission made. */
export interface MissionTransition {
  /** The state the mission was in. */
  readonly from: MissionState;
  /** The state it moved to. */
  readonly to: MissionState;
  /** What happened. */
  readonly trigger: MissionTrigger;
  /** Which side of the game it came from. */
  readonly actor: MissionTransitionActor;
  /**
   * When the engine decided it.
   *
   * Not when a phone recorded the event. A submission queued offline
   * (EXPD-048) is stamped by the device when it was written and by the
   * engine when it was applied, and the two can be an hour apart. This is the
   * second of those, which is why lines in a log read in order even though
   * the events behind them did not arrive in order.
   */
  readonly at: IsoTimestamp;
  /**
   * Which try this was about, counting from one.
   *
   * Zero before the team has opened the mission for the first time, because
   * `unlock`, `relock` and a skip from `available` all happen with no try
   * running. It lines up with `mission_attempt.attempt_number`.
   */
  readonly attemptNumber: number;
  /**
   * Why, in a sentence, when there is more to say than the trigger.
   *
   * A teacher's note on an overruled submission, or which clock ran out.
   * Never the answer to the mission.
   */
  readonly reason?: string;
  /**
   * Anything the caller wants kept with the line.
   *
   * Stored and handed back. The engine does not read it, the same way it
   * does not read a behaviour's `detail` (EXPD-009).
   */
  readonly detail?: JsonObject;
}

/** Why a transition was not allowed. */
export type MissionTransitionRefusalCode =
  /** The trigger has no edge out of the state the mission is in. */
  | 'wrong-state'
  /** The mission has already finished, so nothing moves it. */
  | 'terminal-state'
  /** The team has used every try the mission's attempt policy allows. */
  | 'no-attempts-left'
  /** The expedition's rules do not let a team skip a mission. */
  | 'skip-not-allowed'
  /** The word given is not a trigger at all. */
  | 'unknown-trigger';

/**
 * A transition the rules would not make.
 *
 * Refusals are ordinary answers rather than failures. Two phones on one team
 * both press submit, a teacher reviews a queue a team has already moved on
 * from, a queued offline event arrives after the mission timed out — all of
 * those are a team playing normally, and none of them should be an error in a
 * log somewhere. A refused transition changes nothing and is not written to
 * the mission's history.
 */
export interface MissionTransitionRefusal {
  readonly code: MissionTransitionRefusalCode;
  /** The state the mission is still in. */
  readonly state: MissionState;
  /** What was asked for. The literal value, when it was not a trigger at all. */
  readonly trigger: string;
  /** A sentence a person can read. */
  readonly message: string;
}

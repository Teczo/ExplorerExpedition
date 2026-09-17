/**
 * The two rules that change which transition follows an event (EXPD-010).
 *
 * The transition table says what the shape of the game is. Two settings in
 * the Expedition Definition bend it for one mission in one expedition:
 *
 *   1. `MissionInstance.attempts.maxAttempts` decides whether a wrong answer
 *      sends a team back for another go or ends the mission.
 *   2. `ExpeditionRules.allowSkip` decides whether a team may walk away from
 *      a mission at all.
 *
 * They are gathered into one small value rather than passed as a definition,
 * because the state machine has no business reading a mission's title, its
 * hints or its scoring — and because a simulation run (EXPD-015) wants to
 * turn these two dials without building a whole expedition to do it.
 *
 * Everything else in those two documents belongs to another ticket.
 * `cooldownSeconds` is how long a team waits before pressing start again and
 * `timeLimitSeconds` is when a running try gives up; both are clocks, the
 * engine holds no clock, and the caller that owns the clock applies `start`
 * or `expire` when it is time. `progression` is EXPD-013's, because which
 * missions unlock together is a question about the graph rather than about
 * one mission.
 */

import type { ExpeditionRules, MissionInstance } from '@explorer/shared-types';

/** What the attempt policy and the expedition rules do to one mission. */
export interface MissionStatePolicy {
  /**
   * The largest number of tries the team may open.
   *
   * `null` means there is no limit, which is what `AttemptPolicy` means by
   * `null` too.
   */
  readonly maxAttempts: number | null;
  /** Whether the team may leave a mission unfinished and move on. */
  readonly allowSkip: boolean;
}

/**
 * What a mission runs under when nobody says otherwise.
 *
 * Unlimited tries and no skipping: the two settings that let a team keep
 * playing, and the one that lets them stop, at their most cautious. A caller
 * that forgets to pass a policy gets a mission nobody can abandon rather than
 * one anybody can walk away from.
 */
export const DEFAULT_MISSION_STATE_POLICY: MissionStatePolicy = {
  maxAttempts: null,
  allowSkip: false,
};

/**
 * Reads the policy for one mission out of the documents that hold it.
 *
 * `free-roam` is the one case where the rules and the flag disagree.
 * `ExpeditionRules.allowSkip` says it is ignored there, because in free-roam
 * nothing is blocking the team in the first place — so a team may always mark
 * a free-roam mission as one they are not doing, whatever the flag says.
 */
export function missionStatePolicyFor(
  mission: MissionInstance,
  rules: ExpeditionRules,
): MissionStatePolicy {
  return {
    maxAttempts: mission.attempts?.maxAttempts ?? null,
    allowSkip: rules.progression === 'free-roam' ? true : rules.allowSkip === true,
  };
}

/** Says whether the team may open one more try. */
export function hasAttemptLeft(attemptsUsed: number, policy: MissionStatePolicy): boolean {
  return policy.maxAttempts === null || attemptsUsed < policy.maxAttempts;
}

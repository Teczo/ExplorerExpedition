/**
 * What the two documents say about checking one mission (EXPD-011).
 *
 * The completion interface reads four settings, and they are spread over two
 * documents. Three are on the mission — how its work is judged, how long a
 * team has once they open it, and where they have to be. The fourth is on the
 * expedition, because an author may say that every submission in this
 * expedition goes to a teacher whatever its mission says.
 *
 * They are gathered here for the same two reasons `MissionStatePolicy`
 * (EXPD-010) gathers its own: the interface has no business reading a
 * mission's title or its hints, and the simulation harness (EXPD-015) wants
 * to turn these dials without building a whole expedition to turn them on.
 *
 * **The interface reads these and never the mission.** A submission being
 * checked carries the mission as well, because the mission type's key,
 * version and settings are needed to judge one. Reading `verification` off
 * that mission instead of off the policy would put one setting in two places,
 * and two places is where they come to disagree.
 *
 * Everything else in those documents belongs elsewhere. `attempts` and
 * `allowSkip` are the state machine's (EXPD-010), `scoring` is EXPD-012's,
 * `cooldownSeconds` is a clock in front of `start` rather than behind a
 * submission, and `latePolicy` is about the expedition's clock rather than a
 * mission's, so it belongs with the session (EXPD-019).
 */

import type {
  ExpeditionRules,
  LocationConstraint,
  MissionInstance,
  Seconds,
  VerificationMode,
} from '@explorer/shared-types';

/** What the two documents say about checking one mission. */
export interface MissionCompletionPolicy {
  /** How the mission's own author said its work is judged. */
  readonly verification: VerificationMode;
  /**
   * Whether the expedition sends every submission to a teacher.
   *
   * `ExpeditionRules.submissions.requireReviewForAll`. It only ever adds
   * review: an expedition cannot take away a review a mission asked for.
   */
  readonly requireReviewForAll: boolean;
  /**
   * How long a team has once they open the mission, in seconds.
   *
   * `null` when the mission is not timed. The engine holds no clock, so this
   * is what it measures a caller's `expire` against rather than something it
   * counts down itself.
   */
  readonly timeLimitSeconds: Seconds | null;
  /** Where the team has to be for their work to count. `null` when anywhere. */
  readonly location: LocationConstraint | null;
}

/**
 * What a mission is checked under when nobody says otherwise.
 *
 * Judged by its type, no blanket review, no clock and no place. It is the
 * plainest mission there is, and a caller that forgets to pass a policy gets
 * one rather than getting a mission nobody can finish.
 */
export const DEFAULT_MISSION_COMPLETION_POLICY: MissionCompletionPolicy = {
  verification: 'automatic',
  requireReviewForAll: false,
  timeLimitSeconds: null,
  location: null,
};

/** Reads the policy for one mission out of the documents that hold it. */
export function missionCompletionPolicyFor(
  mission: MissionInstance,
  rules: ExpeditionRules,
): MissionCompletionPolicy {
  return {
    verification: mission.verification,
    requireReviewForAll: rules.submissions?.requireReviewForAll === true,
    timeLimitSeconds: mission.timeLimitSeconds ?? null,
    location: mission.location ?? null,
  };
}

/**
 * How a mission's work is judged once the expedition has had its say.
 *
 * The expedition's blanket rule only ever turns review on, so this is the
 * mission's own mode unless that rule overrides it with `teacher`.
 */
export function effectiveVerification(
  policy: MissionCompletionPolicy,
): VerificationMode {
  return policy.requireReviewForAll ? 'teacher' : policy.verification;
}

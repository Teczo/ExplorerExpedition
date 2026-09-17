/**
 * The completion and validation interface (EXPD-011).
 *
 * One door. Everything that can finish a mission comes through it, whether a
 * mission type judged it, a person did, or a clock did, and whatever happens
 * the answer has the same shape: a verdict saying what was concluded and what
 * concluded it, a mission that has moved, and the lines written in its
 * history saying so.
 *
 * ```ts
 * const result = completeMission({
 *   kind: 'submission',
 *   registry,
 *   mission,
 *   progress,
 *   payload: { scanned: 'EXPD-7742' },
 *   position,
 *   at: now,
 *   completionPolicy: missionCompletionPolicyFor(mission, definition.rules),
 *   statePolicy: missionStatePolicyFor(mission, definition.rules),
 * });
 *
 * if (result.applied) {
 *   progress = result.progress;             // a new record; the old one stands
 *   send(result.verdict);                   // what to show the team
 * } else {
 *   return reply.status(409).send({ refusal: result.refusal });
 * }
 * ```
 *
 * **The six ways a mission is completed are not six branches.** A scanned
 * code that matched and an answer that was right are both a mission type's
 * behaviour saying `correct`; the engine cannot tell them apart and has no
 * reason to. A photo handed in is that same behaviour saying it cannot
 * decide, or an author saying up front that a person will. A place reached is
 * the one check the engine owns itself, because the area is on the mission
 * rather than in the mission type's settings. A teacher's approval is a
 * person's decision arriving on its own. A clock running out is the one thing
 * that finishes a mission with nothing handed in at all. That is three ways
 * in — a submission, a decision, a clock — and one way out.
 *
 * **It decides, and the state machine moves.** Every verdict becomes a
 * trigger and is handed to `applyMissionTransition` (EXPD-010). Nothing here
 * writes a mission state, so there is still exactly one place a mission state
 * changes and exactly one table that says what may change it.
 *
 * **It is pure.** No clock, no network, no state kept between calls. The same
 * request gives the same answer twice, which is what lets the simulation
 * harness (EXPD-015) run an expedition a thousand times and what lets anybody
 * re-check a verdict a team is arguing with.
 *
 * **What it does not do.** It does not score: what an outcome is worth is
 * EXPD-012, which reads the verdict. It does not decide what a completed
 * mission unlocks: that is EXPD-013, which reads the state. It does not store
 * anything: rows are EXPD-020's. And it never calls a mission type to find
 * out *when* something may be attempted — that is the state machine's, and it
 * is asked first.
 */

import {
  validateAgainstSchema,
  type IsoTimestamp,
  type JsonObject,
  type CompletionRefusal,
  type CompletionRefusalCode,
  type CompletionReview,
  type CompletionVerdict,
  type MissionInstance,
  type MissionProgress,
  type MissionTransition,
  type MissionTransitionActor,
  type MissionTransitionRefusal,
  type MissionTrigger,
  type ReportedPosition,
} from '@explorer/shared-types';

import type { MissionTypeRegistry } from '../mission-types/registry.ts';
import type { MissionOutcome } from '../mission-types/behaviour.ts';
import {
  applyMissionTransition,
  type MissionTransitionInput,
} from '../mission-state/machine.ts';
import {
  DEFAULT_MISSION_STATE_POLICY,
  type MissionStatePolicy,
} from '../mission-state/policy.ts';
import { checkMissionLocation, type LocationCheck } from './location.ts';
import {
  DEFAULT_MISSION_COMPLETION_POLICY,
  effectiveVerification,
  type MissionCompletionPolicy,
} from './policy.ts';
import { hasMissionExpired, missionDeadline } from './timer.ts';

/** What every check carries, whichever of the three it is. */
interface CompletionCheckBase {
  /** The mission as it stands for this team now. */
  readonly progress: MissionProgress;
  /** When the caller is deciding it. Written into the history as given. */
  readonly at: IsoTimestamp;
  /** The state machine's two settings. Defaults to its own default. */
  readonly statePolicy?: MissionStatePolicy;
}

/** A team handed work in. */
export interface SubmissionCheck extends CompletionCheckBase {
  readonly kind: 'submission';
  /**
   * The mission types this expedition is being played with.
   *
   * Per request scope, never a shared one (EXPD-009). It is on the request
   * rather than on the interface because a submission is the only one of the
   * three checks that needs a mission type at all.
   */
  readonly registry: MissionTypeRegistry;
  /**
   * The mission, for its type's key, its version and its settings.
   *
   * Everything else the check reads about the mission comes from
   * `completionPolicy`, so that no setting is read from two places.
   */
  readonly mission: MissionInstance;
  /** What the team sent. Checked against the type's submission schema. */
  readonly payload: JsonObject;
  /** Where the device said it was, when it said. */
  readonly position?: ReportedPosition;
  /**
   * What the mission type's `prepare` made of this mission's settings.
   *
   * Pass it in and a hunt with two hundred codes in it is indexed once per
   * mission rather than once per attempt (EXPD-009). Leave it out and the
   * interface prepares the config itself, which is correct and slower.
   */
  readonly prepared?: unknown;
  /** Which side of the game handed it in. A team, unless said otherwise. */
  readonly actor?: MissionTransitionActor;
  /** What the two documents say about checking this mission. */
  readonly completionPolicy?: MissionCompletionPolicy;
}

/** A teacher decided about work that was waiting on one (EXPD-056). */
export interface ReviewCheck extends CompletionCheckBase {
  readonly kind: 'review';
  /** What they decided. */
  readonly decision: 'approve' | 'reject';
  /** Their note, in a sentence. Written into the mission's history. */
  readonly reason?: string;
  /** Anything else to keep with the line. The engine does not read it. */
  readonly detail?: JsonObject;
}

/** A mission's own clock ran out (EXPD-002's `timeLimitSeconds`). */
export interface ExpiryCheck extends CompletionCheckBase {
  readonly kind: 'expiry';
  /** Why, when there is more to say than that the time was up. */
  readonly reason?: string;
  /**
   * What the two documents say about checking this mission.
   *
   * The time limit is read off this to check that the clock really has run
   * out. Leaving it out means there is no limit to check against, so the
   * expiry is taken at the caller's word.
   */
  readonly completionPolicy?: MissionCompletionPolicy;
}

/** One thing that could finish a mission. */
export type CompletionRequest = SubmissionCheck | ReviewCheck | ExpiryCheck;

/** What came of putting one of those through the interface. */
export type CompletionResult =
  | {
      readonly applied: true;
      /** The mission after the change. A new value; the old one is untouched. */
      readonly progress: MissionProgress;
      /** What was concluded, and what concluded it. */
      readonly verdict: CompletionVerdict;
      /**
       * The lines added to the mission's history, oldest first.
       *
       * A submission adds two: the team handing work in, and the verdict on
       * it. A decision and an expiry add one each.
       */
      readonly transitions: readonly MissionTransition[];
    }
  | {
      readonly applied: false;
      /** The mission, unchanged and with nothing added to its history. */
      readonly progress: MissionProgress;
      readonly refusal: CompletionRefusal;
    };

function refuse(
  progress: MissionProgress,
  code: CompletionRefusalCode,
  message: string,
  extra: Omit<CompletionRefusal, 'code' | 'message'> = {},
): CompletionResult {
  return { applied: false, progress, refusal: { code, message, ...extra } };
}

/** Wraps a refusal the state machine made, so one shape comes back either way. */
function notNow(
  progress: MissionProgress,
  stateRefusal: MissionTransitionRefusal,
): CompletionResult {
  return refuse(progress, 'not-now', stateRefusal.message, { stateRefusal });
}

/** The trigger an outcome becomes on a submission. */
function triggerForOutcome(outcome: MissionOutcome): MissionTrigger {
  switch (outcome) {
    case 'correct':
      return 'accept';
    case 'incorrect':
      return 'reject';
    case 'needs-review':
      return 'refer';
  }
}

/** Whether anybody still has to look, once the verdict is in. */
function reviewFor(
  trigger: MissionTrigger,
  policy: MissionCompletionPolicy,
): CompletionReview {
  if (trigger === 'refer') {
    return 'required';
  }
  return effectiveVerification(policy) === 'automatic-with-review'
    ? 'optional'
    : 'none';
}

/** Keeps a behaviour's progress figure inside the nought-to-one it promised. */
function clampProgress(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(1, Math.max(0, value));
}

/** What the mission type made of a submission, before it became a trigger. */
interface Judgement {
  readonly outcome: MissionOutcome;
  readonly method: CompletionVerdict['method'];
  readonly progress?: number;
  readonly feedback?: string;
  readonly reason?: string;
  readonly detail?: JsonObject;
}

/**
 * Judges one submission.
 *
 * Four ways, tried in this order, and the order is the decision:
 *
 *   1. The mission says a person decides, so nothing here does. A mission
 *      type's code is not run at all in that case: the author said the answer
 *      is a judgement call, and running code to produce an answer nobody will
 *      use would only put a second opinion in the log.
 *   2. The mission type has code, so it judges.
 *   3. It has none, and the team reached the place the mission names, so that
 *      was the mission.
 *   4. It has none and there was no place either, so a person decides
 *      (EXPD-037). A type built in the Studio (EXPD-025) is a row and
 *      nothing more, and a row cannot judge anything.
 */
function judge(
  request: SubmissionCheck,
  policy: MissionCompletionPolicy,
  location: LocationCheck,
): Judgement {
  if (effectiveVerification(policy) === 'teacher') {
    return {
      outcome: 'needs-review',
      method: 'referral',
      reason: policy.requireReviewForAll
        ? 'This expedition has a teacher check every submission.'
        : 'This mission is marked for a teacher to check.',
    };
  }

  const behaviour = request.registry.behaviourFor(
    request.mission.missionTypeId,
    request.mission.missionTypeVersion,
  );

  if (behaviour === undefined) {
    if (location.reached) {
      return {
        outcome: 'correct',
        method: 'location',
        progress: 1,
        feedback: location.message,
      };
    }
    return {
      outcome: 'needs-review',
      method: 'referral',
      reason: 'This mission type has no code to judge with, so a person decides.',
    };
  }

  let evaluation;
  try {
    evaluation = behaviour.evaluate({
      config: request.mission.config,
      prepared:
        request.prepared ??
        request.registry.prepareConfig(
          request.mission.missionTypeId,
          request.mission.missionTypeVersion,
          request.mission.config,
        ),
      submission: request.payload,
      attemptNumber: request.progress.attemptsUsed,
    });
  } catch (error) {
    // A mission type that throws is a mission type with a bug in it, and a
    // class standing in a field is the wrong place to find that out. The team
    // is not failed for it and is not told about it: the submission goes to
    // the teacher, and the log says why it had to.
    return {
      outcome: 'needs-review',
      method: 'referral',
      reason:
        'The mission type could not judge this submission: ' +
        (error instanceof Error ? error.message : String(error)),
    };
  }

  if (evaluation.outcome !== 'correct' && evaluation.outcome !== 'incorrect' &&
      evaluation.outcome !== 'needs-review') {
    return {
      outcome: 'needs-review',
      method: 'referral',
      reason: `The mission type answered "${String(evaluation.outcome)}", which is not an outcome.`,
    };
  }

  const progress = clampProgress(evaluation.progress);
  return {
    outcome: evaluation.outcome,
    method: 'behaviour',
    ...(progress === undefined ? {} : { progress }),
    ...(evaluation.feedback === undefined ? {} : { feedback: evaluation.feedback }),
    ...(evaluation.detail === undefined ? {} : { detail: evaluation.detail }),
  };
}

/** Builds the input for the transition a verdict became. */
function transitionInput(
  verdict: CompletionVerdict,
  actor: MissionTransitionActor,
  at: IsoTimestamp,
): MissionTransitionInput {
  return {
    trigger: verdict.trigger,
    actor,
    at,
    ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
    ...(verdict.detail === undefined ? {} : { detail: verdict.detail }),
  };
}

/** A team handed work in: checked, judged, and handed to the state machine. */
function completeSubmission(request: SubmissionCheck): CompletionResult {
  const { progress } = request;
  const statePolicy = request.statePolicy ?? DEFAULT_MISSION_STATE_POLICY;
  const policy = request.completionPolicy ?? DEFAULT_MISSION_COMPLETION_POLICY;

  // The state machine is asked first, and nothing is written until the end.
  // A mission that has finished, or that the team never opened, is refused
  // here — before a mission type is looked up, before a place is checked and
  // before any code runs on what the team sent.
  const submitted = applyMissionTransition(
    progress,
    { trigger: 'submit', actor: request.actor ?? 'team', at: request.at },
    statePolicy,
  );
  if (!submitted.applied) {
    return notNow(progress, submitted.refusal);
  }

  const key = request.mission.missionTypeId;
  const version = request.mission.missionTypeVersion;
  const registered = request.registry.get(key, version);
  if (registered === undefined) {
    return refuse(
      progress,
      'unknown-mission-type',
      `Nothing has registered the mission type "${key}@${version}", so this ` +
        'submission cannot be checked.',
    );
  }

  // Where the team is comes before what they sent. Work handed in from the
  // wrong place is not wrong work, so it is not judged and not counted.
  const location = checkMissionLocation(policy.location, request.position);
  if (!location.allowed) {
    return refuse(
      progress,
      location.code === 'wrong-place' ? 'wrong-place' : 'poor-accuracy',
      location.message,
      location.metresFromCentre === undefined
        ? {}
        : { metresAway: location.metresFromCentre },
    );
  }

  const shape = validateAgainstSchema(
    registered.definition.submissionSchema,
    request.payload,
    { path: 'payload' },
  );
  if (!shape.valid) {
    return refuse(
      progress,
      'invalid-submission',
      `This is not the shape a ${registered.ref} submission takes.`,
      { issues: shape.issues },
    );
  }

  const judged = judge(request, policy, location);
  const trigger = triggerForOutcome(judged.outcome);
  const verdict: CompletionVerdict = {
    outcome: judged.outcome,
    method: judged.method,
    trigger,
    review: reviewFor(trigger, policy),
    ...(judged.progress === undefined ? {} : { progress: judged.progress }),
    ...(judged.feedback === undefined ? {} : { feedback: judged.feedback }),
    ...(judged.reason === undefined ? {} : { reason: judged.reason }),
    ...(judged.detail === undefined ? {} : { detail: judged.detail }),
  };

  // The verdict is the engine's, whoever handed the work in.
  const decided = applyMissionTransition(
    submitted.progress,
    transitionInput(verdict, 'engine', request.at),
    statePolicy,
  );
  if (!decided.applied) {
    return notNow(progress, decided.refusal);
  }

  return {
    applied: true,
    progress: decided.progress,
    verdict,
    transitions: [submitted.transition, decided.transition],
  };
}

/** A teacher decided: one transition, and the person is the actor. */
function completeReview(request: ReviewCheck): CompletionResult {
  const statePolicy = request.statePolicy ?? DEFAULT_MISSION_STATE_POLICY;
  const approved = request.decision === 'approve';
  const verdict: CompletionVerdict = {
    outcome: approved ? 'correct' : 'incorrect',
    method: 'teacher',
    trigger: approved ? 'verify' : 'overrule',
    review: 'none',
    ...(approved ? { progress: 1 } : {}),
    ...(request.reason === undefined ? {} : { reason: request.reason }),
    ...(request.detail === undefined ? {} : { detail: request.detail }),
  };

  const decided = applyMissionTransition(
    request.progress,
    transitionInput(verdict, 'teacher', request.at),
    statePolicy,
  );
  if (!decided.applied) {
    return notNow(request.progress, decided.refusal);
  }

  return {
    applied: true,
    progress: decided.progress,
    verdict,
    transitions: [decided.transition],
  };
}

/** A clock ran out: checked against the mission's own limit, then applied. */
function completeExpiry(request: ExpiryCheck): CompletionResult {
  const statePolicy = request.statePolicy ?? DEFAULT_MISSION_STATE_POLICY;
  const policy = request.completionPolicy ?? DEFAULT_MISSION_COMPLETION_POLICY;

  const verdict: CompletionVerdict = {
    outcome: 'expired',
    method: 'timer',
    trigger: 'expire',
    review: 'none',
    reason:
      request.reason ??
      (policy.timeLimitSeconds === null
        ? 'Time ran out.'
        : `The team had ${String(policy.timeLimitSeconds)} seconds and did not hand anything in.`),
  };

  // The state machine is asked first, the same way it is for a submission, so
  // that a timer going off on a mission nobody is playing is answered by
  // whichever of the two is nearer the truth: it is not running.
  const decided = applyMissionTransition(
    request.progress,
    transitionInput(verdict, 'engine', request.at),
    statePolicy,
  );
  if (!decided.applied) {
    return notNow(request.progress, decided.refusal);
  }

  // The engine holds no clock, so it cannot tell a timer that fired on time
  // from one that fired early. What it can do is the arithmetic: the mission
  // says how long a team has and the history says when they started.
  if (policy.timeLimitSeconds !== null && !hasMissionExpired(policy, request.progress, request.at)) {
    const expiresAt = missionDeadline(policy, request.progress);
    return refuse(
      request.progress,
      'not-yet-expired',
      expiresAt === undefined
        ? 'This mission has a time limit and no try running, so nothing can have run out.'
        : `This mission's time is not up until ${expiresAt}.`,
      expiresAt === undefined ? {} : { expiresAt },
    );
  }

  return {
    applied: true,
    progress: decided.progress,
    verdict,
    transitions: [decided.transition],
  };
}

/**
 * Checks one thing that could finish a mission, and moves it if it did.
 *
 * The one entry point. Whatever came in, what comes back is either a verdict
 * and a mission that has moved, or a refusal and a mission that has not.
 */
export function completeMission(request: CompletionRequest): CompletionResult {
  switch (request.kind) {
    case 'submission':
      return completeSubmission(request);
    case 'review':
      return completeReview(request);
    case 'expiry':
      return completeExpiry(request);
  }
}

/**
 * The mission state machine (EXPD-010).
 *
 * One team, one mission, eight states. Something happens, the machine is told
 * what happened, and it either moves the mission and writes a line in its
 * history or refuses and changes nothing. Those are the only two outcomes,
 * and there is no third way for a mission state to change.
 *
 * ```ts
 * let progress = createMissionProgress(mission.id);
 * const policy = missionStatePolicyFor(mission, definition.rules);
 *
 * const opened = applyMissionTransition(
 *   progress,
 *   { trigger: 'unlock', actor: 'engine', at: now },
 *   policy,
 * );
 * if (opened.applied) {
 *   progress = opened.progress;
 * }
 * ```
 *
 * **Nothing here decides anything.** The machine is told that a submission
 * was right (`accept`), that an unlock condition holds (`unlock`), that a
 * clock ran out (`expire`). Judging a submission is the mission type's
 * behaviour (EXPD-009) through the completion interface (EXPD-011), working
 * out that a condition holds is EXPD-013, and what any of it is worth is
 * EXPD-012. Keeping those out is what lets this file be a table and a walk
 * over it.
 *
 * **Nothing here reads a clock.** Every function takes the time it should
 * write down. The engine has to be replayable — the same history has to give
 * the same answer twice, for the simulation harness (EXPD-015) and for
 * `replayMissionTransitions` below — and a function that reads `Date.now()`
 * cannot be.
 *
 * **Nothing here is edited.** A `MissionProgress` that goes in comes back
 * out untouched; what comes back is a new one. A caller holding the old value
 * — a realtime frame already sent, a row already written — still holds what
 * it held.
 */

import {
  isMissionTrigger,
  isTerminalMissionState,
  MISSION_TRIGGERS,
  type IsoTimestamp,
  type JsonObject,
  type MissionInstanceId,
  type MissionProgress,
  type MissionState,
  type MissionTransition,
  type MissionTransitionActor,
  type MissionTransitionRefusal,
  type MissionTransitionRefusalCode,
  type MissionTrigger,
} from '@explorer/shared-types';

import { MissionTransitionRefusedError } from './errors.ts';
import {
  DEFAULT_MISSION_STATE_POLICY,
  hasAttemptLeft,
  type MissionStatePolicy,
} from './policy.ts';
import { MISSION_TRANSITIONS, type MissionTransitionRule } from './table.ts';

/** What the machine is told happened. */
export interface MissionTransitionInput {
  /**
   * What happened.
   *
   * A plain string is accepted as well, because this often arrives from a
   * request body. A word that is not a trigger comes back as an
   * `unknown-trigger` refusal rather than as a thrown error.
   */
  readonly trigger: MissionTrigger | string;
  /** Which side of the game it came from. */
  readonly actor: MissionTransitionActor;
  /** When the caller is deciding it. Written into the history as given. */
  readonly at: IsoTimestamp;
  /** Why, when there is more to say than the trigger. */
  readonly reason?: string;
  /** Anything to keep with the line. The engine stores it and does not read it. */
  readonly detail?: JsonObject;
}

/** What came of telling the machine something happened. */
export type MissionTransitionResult =
  | {
      readonly applied: true;
      /** The mission after the change. A new value; the old one is untouched. */
      readonly progress: MissionProgress;
      /** The line just written, which is also the last line of the history. */
      readonly transition: MissionTransition;
    }
  | {
      readonly applied: false;
      /** The mission, unchanged and with nothing added to its history. */
      readonly progress: MissionProgress;
      readonly refusal: MissionTransitionRefusal;
    };

/** How a mission starts out. */
export interface MissionProgressOptions {
  /**
   * The state to begin in. `locked` unless said otherwise.
   *
   * The missions an expedition opens with, and every mission in a free-roam
   * expedition, begin `available` instead. Which those are is EXPD-013's to
   * work out from the graph; this only takes the answer.
   */
  readonly state?: MissionState;
}

/**
 * Starts a mission off for one team.
 *
 * No tries used and an empty history. To rebuild one that has already been
 * played, start here and replay its stored lines with
 * `replayMissionTransitions` rather than assembling a record by hand — that
 * way the rules get a say in whether the history is one the game could have
 * produced.
 */
export function createMissionProgress(
  missionInstanceId: MissionInstanceId,
  options: MissionProgressOptions = {},
): MissionProgress {
  return {
    missionInstanceId,
    state: options.state ?? 'locked',
    attemptsUsed: 0,
    log: [],
  };
}

/** Where a rule leaves a mission, once the attempt policy has had its say. */
function destinationOf(
  rule: MissionTransitionRule,
  attemptsUsed: number,
  policy: MissionStatePolicy,
): MissionState {
  if (rule.whenNoAttemptsLeft !== undefined && !hasAttemptLeft(attemptsUsed, policy)) {
    return rule.whenNoAttemptsLeft;
  }
  return rule.to;
}

function refuse(
  code: MissionTransitionRefusalCode,
  state: MissionState,
  trigger: string,
  message: string,
): MissionTransitionRefusal {
  return { code, state, trigger, message };
}

/**
 * Works out what a trigger would do, without doing it.
 *
 * Returns the state the mission would land in, or the refusal that would come
 * back. `allowedMissionTriggers` and `applyMissionTransition` are both this
 * function with something done to its answer.
 */
function resolve(
  progress: MissionProgress,
  trigger: string,
  policy: MissionStatePolicy,
):
  | {
      readonly rule: MissionTransitionRule;
      readonly trigger: MissionTrigger;
      readonly to: MissionState;
    }
  | { readonly refusal: MissionTransitionRefusal } {
  const state = progress.state;

  if (!isMissionTrigger(trigger)) {
    return {
      refusal: refuse(
        'unknown-trigger',
        state,
        trigger,
        `"${trigger}" is not something that happens to a mission. The triggers ` +
          `are: ${MISSION_TRIGGERS.join(', ')}.`,
      ),
    };
  }

  if (isTerminalMissionState(state)) {
    return {
      refusal: refuse(
        'terminal-state',
        state,
        trigger,
        `The mission is ${state}, which is where it stays. Nothing can ${trigger} it.`,
      ),
    };
  }

  const rule = MISSION_TRANSITIONS[trigger];
  if (!rule.from.includes(state)) {
    return {
      refusal: refuse(
        'wrong-state',
        state,
        trigger,
        `A mission can only ${trigger} from ${rule.from.join(' or ')}, and this ` +
          `one is ${state}.`,
      ),
    };
  }

  if (rule.opensAttempt === true && !hasAttemptLeft(progress.attemptsUsed, policy)) {
    return {
      refusal: refuse(
        'no-attempts-left',
        state,
        trigger,
        `The team has used all ${String(policy.maxAttempts)} tries at this mission.`,
      ),
    };
  }

  if (rule.needsSkipAllowed === true && !policy.allowSkip) {
    return {
      refusal: refuse(
        'skip-not-allowed',
        state,
        trigger,
        'This expedition does not let a team skip a mission.',
      ),
    };
  }

  return { rule, trigger, to: destinationOf(rule, progress.attemptsUsed, policy) };
}

/**
 * Tells the machine something happened.
 *
 * On a change, the mission moves and one line is added to its history. On a
 * refusal, nothing moves and nothing is written: a refused transition is not
 * part of a mission's history, because it is not something that happened to
 * the mission.
 */
export function applyMissionTransition(
  progress: MissionProgress,
  input: MissionTransitionInput,
  policy: MissionStatePolicy = DEFAULT_MISSION_STATE_POLICY,
): MissionTransitionResult {
  const resolved = resolve(progress, input.trigger, policy);
  if ('refusal' in resolved) {
    return { applied: false, progress, refusal: resolved.refusal };
  }

  const attemptsUsed =
    resolved.rule.opensAttempt === true
      ? progress.attemptsUsed + 1
      : progress.attemptsUsed;

  const transition: MissionTransition = {
    from: progress.state,
    to: resolved.to,
    trigger: resolved.trigger,
    actor: input.actor,
    at: input.at,
    attemptNumber: attemptsUsed,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.detail === undefined ? {} : { detail: input.detail }),
  };

  return {
    applied: true,
    transition,
    progress: {
      missionInstanceId: progress.missionInstanceId,
      state: resolved.to,
      attemptsUsed,
      log: [...progress.log, transition],
    },
  };
}

/**
 * The same, for a caller that has already checked.
 *
 * @throws MissionTransitionRefusedError when the rules would not make the
 * change. A caller acting on something a team did should use
 * `applyMissionTransition` and handle the refusal, the same way a caller that
 * can carry on without a mission type uses `get` rather than `require`.
 */
export function requireMissionTransition(
  progress: MissionProgress,
  input: MissionTransitionInput,
  policy: MissionStatePolicy = DEFAULT_MISSION_STATE_POLICY,
): MissionProgress {
  const result = applyMissionTransition(progress, input, policy);
  if (!result.applied) {
    throw new MissionTransitionRefusedError(result.refusal);
  }
  return result.progress;
}

/**
 * Everything that could happen to this mission right now.
 *
 * In the order `MISSION_TRIGGERS` lists them. The student app asks this to
 * know which buttons to draw, and Director Mode asks it to know what it may
 * offer a teacher — so that a team is never shown a submit button that the
 * rules would refuse the moment it is pressed.
 */
export function allowedMissionTriggers(
  progress: MissionProgress,
  policy: MissionStatePolicy = DEFAULT_MISSION_STATE_POLICY,
): MissionTrigger[] {
  return MISSION_TRIGGERS.filter(
    (trigger) => !('refusal' in resolve(progress, trigger, policy)),
  );
}

/**
 * Where a trigger would leave the mission, without applying it.
 *
 * Returns `undefined` when it would be refused. It is what lets a caller show
 * a team what pressing skip would cost them before they press it.
 */
export function missionStateAfter(
  progress: MissionProgress,
  trigger: MissionTrigger,
  policy: MissionStatePolicy = DEFAULT_MISSION_STATE_POLICY,
): MissionState | undefined {
  const resolved = resolve(progress, trigger, policy);
  return 'refusal' in resolved ? undefined : resolved.to;
}

/** What came of replaying a stored history. */
export type MissionReplayResult =
  | {
      readonly consistent: true;
      /** The mission, rebuilt from its history. */
      readonly progress: MissionProgress;
    }
  | {
      readonly consistent: false;
      /** How far the replay got before the history stopped making sense. */
      readonly progress: MissionProgress;
      /** Which line disagreed, counting from zero. */
      readonly index: number;
      /** The line itself, as it was stored. */
      readonly entry: MissionTransition;
      /** What the rules say about it. */
      readonly message: string;
      /** The refusal, when the rules would not have made that change at all. */
      readonly refusal?: MissionTransitionRefusal;
    };

/**
 * Rebuilds a mission from its history, and checks the history while it does.
 *
 * This is what makes a logged transition worth logging. A stored line says
 * the mission went from one state to another; replaying it says whether the
 * rules agree. Three things are caught: a line that starts somewhere the
 * mission was not, a line the rules would have refused, and a line that ended
 * somewhere the rules would not have put it.
 *
 * Two callers want it. The simulation harness (EXPD-015) replays a run and
 * has to land where the run landed. And anybody asking why a team's mission
 * says `failed` gets an answer they can check rather than one they have to
 * take on trust — which is the same reason the score event stream (EXPD-014)
 * exists next door.
 */
export function replayMissionTransitions(
  from: MissionProgress,
  entries: readonly MissionTransition[],
  policy: MissionStatePolicy = DEFAULT_MISSION_STATE_POLICY,
): MissionReplayResult {
  let progress = from;

  for (const [index, entry] of entries.entries()) {
    if (entry.from !== progress.state) {
      return {
        consistent: false,
        progress,
        index,
        entry,
        message:
          `The line says the mission was ${entry.from}, and by then it was ` +
          `${progress.state}.`,
      };
    }

    const result = applyMissionTransition(progress, entry, policy);
    if (!result.applied) {
      return {
        consistent: false,
        progress,
        index,
        entry,
        message: result.refusal.message,
        refusal: result.refusal,
      };
    }

    if (result.transition.to !== entry.to) {
      return {
        consistent: false,
        progress,
        index,
        entry,
        message:
          `The line says ${entry.trigger} left the mission ${entry.to}, and the ` +
          `rules leave it ${result.transition.to}.`,
      };
    }

    progress = result.progress;
  }

  return { consistent: true, progress };
}

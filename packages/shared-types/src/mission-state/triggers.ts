/**
 * What moves a mission from one state to the next (EXPD-010).
 *
 * A state never changes on its own. Something happens — a team opens a
 * mission, a behaviour judges a submission, a teacher signs one off, a clock
 * runs out — and that thing is named here. Every change to a mission state
 * carries one of these words, which is what "all transitions are explicit"
 * means: there is no silent edge, and there is no `else` branch that nudges a
 * mission somewhere nobody asked for.
 *
 * The words are here, with the states, so that a stored transition can be
 * read back by anything. Which trigger is allowed out of which state is the
 * engine's transition table, in `@explorer/engine`.
 *
 * A trigger says *what happened*, never *what the answer was*. Working out
 * that a submission was correct is EXPD-011 and the mission type's own
 * behaviour (EXPD-009); the engine is told the verdict and applies `accept`,
 * `reject` or `refer`. Working out that an unlock condition holds is
 * EXPD-013; the engine is told, and applies `unlock`.
 */

/** The one thing that caused a mission state to change. */
export type MissionTrigger =
  /** The mission's unlock condition now holds, so the team can see it. */
  | 'unlock'
  /**
   * The unlock condition stopped holding, so the mission closes again.
   *
   * Rare, and only reachable from `available`: a team that has already
   * opened a mission is never shut out of it half way. It exists because a
   * condition can go from true to false — a `not` condition, or a score
   * threshold a penalty took the team back under.
   */
  | 'relock'
  /** The team opened the mission. A new try begins here, and only here. */
  | 'start'
  /** The team handed work in. */
  | 'submit'
  /** The work was judged right. */
  | 'accept'
  /** The work was judged wrong. */
  | 'reject'
  /** The work needs a person to look at it before it counts. */
  | 'refer'
  /** A teacher accepted the work. */
  | 'verify'
  /** A teacher rejected the work. */
  | 'overrule'
  /** Time ran out while the team was working on it. */
  | 'expire'
  /** The team chose to move on without finishing it. */
  | 'skip';

/** Every trigger, in the order they are listed above. */
export const MISSION_TRIGGERS = [
  'unlock',
  'relock',
  'start',
  'submit',
  'accept',
  'reject',
  'refer',
  'verify',
  'overrule',
  'expire',
  'skip',
] as const satisfies readonly MissionTrigger[];

/** Says whether a string is one of the triggers above. */
export function isMissionTrigger(value: unknown): value is MissionTrigger {
  return (
    typeof value === 'string' && (MISSION_TRIGGERS as readonly string[]).includes(value)
  );
}

/**
 * Who or what caused a transition.
 *
 * Three, not the four of `audit_actor_kind`, because this is a narrower
 * question. The audit log (EXPD-006) records who made a request; this records
 * which side of the game moved the mission, and the game has three sides. An
 * API route that writes an audit entry for the same event has the full
 * principal (EXPD-004) and uses that.
 */
export type MissionTransitionActor =
  /** A student, from their phone. */
  | 'team'
  /** The platform itself: a judged submission, a clock, an unlock check. */
  | 'engine'
  /** A member of staff: a review decision, or a live override (EXPD-058). */
  | 'teacher';

/** Every actor, in the order they are listed above. */
export const MISSION_TRANSITION_ACTORS = [
  'team',
  'engine',
  'teacher',
] as const satisfies readonly MissionTransitionActor[];

/** Says whether a string is one of the actors above. */
export function isMissionTransitionActor(value: unknown): value is MissionTransitionActor {
  return (
    typeof value === 'string' &&
    (MISSION_TRANSITION_ACTORS as readonly string[]).includes(value)
  );
}

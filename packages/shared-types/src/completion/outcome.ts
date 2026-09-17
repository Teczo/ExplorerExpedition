/**
 * What came of checking a team's work (EXPD-011).
 *
 * A mission is completed in one of six ways, and the platform names all six
 * here rather than in six places: a code was scanned and matched, a photo was
 * handed in, a teacher approved the work, an answer was right, a place was
 * reached, or a clock ran out. Those six are not six branches. They are three
 * words for what was concluded and five words for what concluded it, and
 * every one of the six is a pair of them.
 *
 * The words are here, with the mission states, because everything shows them.
 * The review queue (EXPD-056) groups by what still needs a person, the
 * mission board (EXPD-042) tells a team whether their answer was wrong or is
 * being looked at, and Director Mode (EXPD-055) counts both. None of those
 * should need the engine to read a word. The rules that produce them are the
 * completion interface in `@explorer/engine`.
 */

/** What checking a team's work concluded. */
export type CompletionOutcome =
  /** The team met the mission's requirement. */
  | 'correct'
  /** They did not. Whether they may try again is the state machine's to say. */
  | 'incorrect'
  /** Nothing here could decide, so a person has to look. */
  | 'needs-review'
  /** The clock ran out while the team was working on it. */
  | 'expired';

/**
 * Every outcome, in the order they are listed above.
 *
 * The first three are the same three a mission type's behaviour may return
 * (`MissionOutcome`, EXPD-009). A behaviour never returns `expired`, because
 * a behaviour is given a submission and a clock running out is the absence of
 * one.
 */
export const COMPLETION_OUTCOMES = [
  'correct',
  'incorrect',
  'needs-review',
  'expired',
] as const satisfies readonly CompletionOutcome[];

/** Says whether a string is one of the outcomes above. */
export function isCompletionOutcome(value: unknown): value is CompletionOutcome {
  return (
    typeof value === 'string' && (COMPLETION_OUTCOMES as readonly string[]).includes(value)
  );
}

/** What reached that conclusion. */
export type CompletionMethod =
  /**
   * The mission type's own code judged the submission (EXPD-009).
   *
   * This is what a matched code and a right answer both come back as. The
   * engine does not know which of the two it was, and does not need to.
   */
  | 'behaviour'
  /**
   * Being in the right place was the whole test.
   *
   * The mission names an area and the type has no code of its own, so
   * arriving inside it is what there was to do.
   */
  | 'location'
  /** A person decided (EXPD-037, EXPD-056). */
  | 'teacher'
  /** A clock ran out. */
  | 'timer'
  /**
   * Nothing here could decide, so it was handed to a person.
   *
   * A photo goes this way, and so does any mission an author marked for a
   * teacher. The person's decision arrives later as its own check, and that
   * one is a `teacher`.
   */
  | 'referral';

/** Every method, in the order they are listed above. */
export const COMPLETION_METHODS = [
  'behaviour',
  'location',
  'teacher',
  'timer',
  'referral',
] as const satisfies readonly CompletionMethod[];

/** Says whether a string is one of the methods above. */
export function isCompletionMethod(value: unknown): value is CompletionMethod {
  return (
    typeof value === 'string' && (COMPLETION_METHODS as readonly string[]).includes(value)
  );
}

/** Whether a person still has to look at this submission. */
export type CompletionReview =
  /** Nobody does. The mission has its answer. */
  | 'none'
  /**
   * Somebody must. The mission is waiting on them and nothing else moves it.
   *
   * The mission is in `awaiting-verification`, and the review queue
   * (EXPD-056) is where it is waiting.
   */
  | 'required'
  /**
   * Somebody may. The mission already has its answer and has moved on.
   *
   * This is what `automatic-with-review` means: the team is told straight
   * away, and the submission is still put in front of a teacher. Changing a
   * mission that has already finished is a live override (EXPD-058), because
   * the state machine has no edge out of a finished mission.
   */
  | 'optional';

/** Every review setting, in the order they are listed above. */
export const COMPLETION_REVIEWS = [
  'none',
  'required',
  'optional',
] as const satisfies readonly CompletionReview[];

/** Says whether a string is one of the review settings above. */
export function isCompletionReview(value: unknown): value is CompletionReview {
  return (
    typeof value === 'string' && (COMPLETION_REVIEWS as readonly string[]).includes(value)
  );
}

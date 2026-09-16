/**
 * The runtime behaviour a mission type plugs into the engine.
 *
 * A mission type is two things. The data half — its settings schema, its
 * submission schema, its defaults — is `MissionTypeDefinition` in
 * `@explorer/shared-types`, and it can be written down in a database row.
 * The half that cannot be written down is here: the code that looks at a
 * team's submission and says whether they got it right.
 *
 * **What this file is, and what it is not.** This is the *slot*. The registry
 * holds a behaviour and hands it over; it never calls one. Deciding when a
 * mission may be attempted is the state machine (EXPD-010), the fuller
 * completion and validation interface is EXPD-011, and turning an outcome
 * into points is the scoring engine (EXPD-012). Those tickets fill this slot
 * and may widen it. EXPD-009 only has to make sure there is one, so that a
 * new mission type arrives as a registration and not as a change to the
 * engine.
 *
 * A behaviour has to be **pure**: the same config and the same submission
 * give the same answer, every time. The engine replays attempts when it
 * rebuilds state and the simulation harness (EXPD-015) runs thousands of
 * them, and neither works if an answer can drift. That rules out reading the
 * clock, reading a network, and keeping anything between calls.
 */

import type { JsonObject } from '@explorer/shared-types';

/** What a behaviour made of one submission. */
export type MissionOutcome =
  /** The team met the mission's requirement. */
  | 'correct'
  /** They did not. Whether they may try again is EXPD-010's to say. */
  | 'incorrect'
  /**
   * The type cannot decide on its own, so a person has to look.
   *
   * A photo mission always answers this. It goes to the review queue
   * (EXPD-056), and the teacher's decision is what finally counts.
   */
  | 'needs-review';

/** What a behaviour is given to judge one submission. */
export interface MissionEvaluationInput {
  /** The author's settings for this mission, already checked against the schema. */
  config: JsonObject;
  /**
   * Whatever `prepare` made of that config, or `undefined` when the type has
   * no `prepare`.
   *
   * It is passed back in rather than recomputed so that a type which has to
   * index something — a hunt with two hundred codes in it — pays for that
   * once per mission instead of once per attempt.
   */
  prepared: unknown;
  /** What the team sent, already checked against the submission schema. */
  submission: JsonObject;
  /** Which try this is, counting from one. */
  attemptNumber: number;
}

/** What a behaviour answered. */
export interface MissionEvaluation {
  outcome: MissionOutcome;
  /**
   * How much of the mission is done, from 0 to 1.
   *
   * Only meaningful for a type that can be partly done, such as a hunt where
   * three of five codes have been found. The scoring engine (EXPD-012) is
   * what decides whether partial progress is worth anything; a type that
   * cannot be partly done leaves this out.
   */
  progress?: number;
  /** What to show the team. Never says the answer. */
  feedback?: string;
  /**
   * Anything the type wants kept with the attempt.
   *
   * It is stored and handed back, and the engine does not read it. A hunt
   * keeps the codes found so far in here.
   */
  detail?: JsonObject;
}

/** The code half of one mission type. */
export interface MissionTypeBehaviour {
  /**
   * Turns an author's config into whatever the type wants at runtime.
   *
   * Called once per mission, not once per attempt. The value that comes back
   * is opaque to the engine and arrives as `prepared` on every evaluation.
   * A type with nothing to precompute leaves this out.
   */
  prepare?(config: JsonObject): unknown;

  /** Judges one submission. Has to be pure — see the note at the top. */
  evaluate(input: MissionEvaluationInput): MissionEvaluation;
}

/**
 * What comes back when a mission type checks something.
 *
 * Two different checks report through this file, because the Studio draws
 * both the same way:
 *
 *   1. Checking a *config schema* — is this a schema the platform can run?
 *      The Mission Type Builder (EXPD-025) asks that before it saves.
 *   2. Checking a *value* against a schema — is this mission's `config` the
 *      right shape for its type? The property panel (EXPD-027), the API and
 *      the AI builder all ask that.
 *
 * The shape is deliberately the same as `ValidationIssue` in the Expedition
 * Definition schema (EXPD-002): a path, a code and a sentence. A form that
 * can already put an EXPD-002 issue next to the field it belongs to needs no
 * second way of doing it for these. The code lists differ because the two
 * checks find different things, and a closed list per check is what lets a
 * caller `switch` on one without a default nobody ever reaches.
 */

/** What kind of problem was found in a value, or in a schema. */
export type MissionConfigIssueCode =
  /** A value that had to be an object was not one. */
  | 'not-an-object'
  /** A required field was absent. */
  | 'missing'
  /** A field held the wrong kind of value. */
  | 'wrong-type'
  /** A string that had to hold something was empty. */
  | 'empty-string'
  /** A number that had to be whole was not. */
  | 'not-an-integer'
  /** A number fell outside the range the schema allows. */
  | 'out-of-range'
  /** A number was not a multiple of the step the schema sets. */
  | 'not-a-multiple'
  /** A value was not one of the values the schema lists. */
  | 'not-allowed-value'
  /** A string did not match the pattern the schema sets. */
  | 'pattern-mismatch'
  /** A string or a list held more than the schema allows. */
  | 'too-long'
  /** A string or a list held fewer than the schema allows. */
  | 'too-short'
  /** A list that had to hold different things repeated one. */
  | 'duplicate-item'
  /** An object carried a field the schema does not describe. */
  | 'unknown-field'
  /** A mission named a type, or a version of one, that is not registered. */
  | 'unknown-mission-type'
  /** A schema used a keyword this platform does not run. */
  | 'unsupported-keyword'
  /** A `pattern` was not a regular expression this platform can compile. */
  | 'invalid-pattern'
  /** Two parts of a schema that have to agree did not. */
  | 'inconsistent'
  /** A structure was nested more deeply than is allowed. */
  | 'too-deep';

/** One problem found in a value, or in a schema. */
export interface MissionConfigIssue {
  /**
   * Where the problem is, written the way the field would be reached in code.
   *
   * When a whole expedition is checked the path starts at the document, so
   * it reads `missions[2].config.codes[0].value`. When one config is checked
   * on its own it starts at that config, so the same problem reads
   * `codes[0].value`. Either way the last part names the field to fix.
   */
  path: string;
  code: MissionConfigIssueCode;
  /** A sentence a person can read. */
  message: string;
}

/** What came back from one of the two checks. */
export type MissionConfigValidationResult =
  | { valid: true }
  | {
      valid: false;
      /** Every problem found, in the order the value was walked. */
      issues: MissionConfigIssue[];
    };

/** A result holding no issues. Shared, because it is returned constantly. */
export const VALID_MISSION_CONFIG: MissionConfigValidationResult = { valid: true };

/** Builds a result from a list of issues, empty or not. */
export function toMissionConfigResult(
  issues: MissionConfigIssue[],
): MissionConfigValidationResult {
  return issues.length === 0 ? VALID_MISSION_CONFIG : { valid: false, issues };
}

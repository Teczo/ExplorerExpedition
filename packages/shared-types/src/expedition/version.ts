/**
 * The version of the Expedition Definition schema.
 *
 * Every client, the Studio, the Creator web app, the student app, the Mission
 * Engine and the AI builder read and write the same document. That document
 * carries its own version so that an old file can still be recognised after
 * the schema moves on.
 *
 * Two different version numbers live on an expedition. Do not mix them up.
 *
 *   `schemaVersion`      The version of *this contract*. It changes when the
 *                        platform changes the shape of the document.
 *   `definitionVersion`  The revision number of *one expedition*. It goes up
 *                        every time an author publishes a new revision of
 *                        their own expedition. EXPD-017 owns that counter.
 */

/**
 * The schema version this build of the platform writes.
 *
 * The three numbers follow semantic versioning:
 *
 *   major  A breaking change. A field was removed, renamed, or its meaning
 *          changed. Old documents need a migration before they can be read.
 *   minor  An additive change. A new optional field or a new variant of an
 *          existing union. Old documents are still valid.
 *   patch  A wording or documentation change only. Nothing about the data
 *          changed.
 *
 * A reader must accept any document whose major number it knows about and
 * whose minor number is at or below its own. `isReadableSchemaVersion` below
 * applies that rule.
 */
export const EXPEDITION_SCHEMA_VERSION = '1.0.0';

/**
 * The major versions this build can read.
 *
 * Add a number here only once a migration exists for it.
 */
export const SUPPORTED_SCHEMA_MAJORS: readonly number[] = [1];

/** A schema version split into its three parts. */
export interface SchemaVersionParts {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Splits a version string into its parts.
 *
 * Returns `null` when the string is not three dot-separated whole numbers.
 * Pre-release and build suffixes are not accepted, because the schema does
 * not ship them.
 */
export function parseSchemaVersion(value: string): SchemaVersionParts | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (match === null) {
    return null;
  }
  // The regular expression above guarantees three captured groups.
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/**
 * Says whether this build can read a document written at `value`.
 *
 * The rule is forward compatible within a major version but not across one.
 * A document written by a newer build with a higher minor number may carry
 * fields this build does not know about, so it is rejected rather than read
 * with parts silently missing.
 */
export function isReadableSchemaVersion(value: string): boolean {
  const parts = parseSchemaVersion(value);
  if (parts === null) {
    return false;
  }
  if (!SUPPORTED_SCHEMA_MAJORS.includes(parts.major)) {
    return false;
  }

  const current = parseSchemaVersion(EXPEDITION_SCHEMA_VERSION);
  if (current === null || parts.major !== current.major) {
    // A supported major other than the current one needs its own migration,
    // which is EXPD-017 work. Until then only the current major is readable.
    return false;
  }
  return parts.minor <= current.minor;
}

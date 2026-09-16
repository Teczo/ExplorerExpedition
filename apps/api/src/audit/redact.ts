/**
 * How much of a row goes into an entry, and what has to stay out (EXPD-006).
 *
 * The `changes` column in 0001 was left with a note on it: "EXPD-006 decides
 * how much of a row goes in here, and what has to be left out of it
 * (EXPD-071)". This file is that decision.
 *
 * It rests on one idea. An audit entry is permanent — the table takes an
 * INSERT and nothing else — so anything written into it is written for good.
 * That makes a copy of the row the wrong thing to store, for three separate
 * reasons: it would be far larger than the entry, it would duplicate data
 * somebody may later ask to have deleted, and it would answer a question
 * nobody asked. What somebody asks of an audit log is *what changed*.
 *
 * So three rules, in order:
 *
 *   1. **Only what moved.** A column whose value is the same before and
 *      after is left out entirely.
 *   2. **Never a secret.** A password verifier or a token hash is not
 *      recorded even as a value that changed. The column name is kept, so
 *      the entry still says the password changed, and the value is
 *      `[redacted]`.
 *   3. **Never a child's details.** On a row that belongs to a student, the
 *      personal columns are recorded the same way: the entry says the name
 *      changed without writing down either name. EXPD-071 reviews this list
 *      and will widen it; nothing here is a reason not to.
 *
 * A fourth rule is about size rather than privacy. A column holding a
 * document — an expedition definition, a submission payload — is recorded as
 * a marker rather than copied, and a long string is cut short. An entry
 * should stay a line, not become an archive.
 */

import {
  type AuditChanges,
  type AuditEntityType,
  type AuditValue,
} from '@explorer/shared-types';

/** What a withheld value is recorded as. */
export const REDACTED = '[redacted]';

/** What a value too big to keep is recorded as. */
export const NOT_RECORDED = '[not recorded]';

/** How much of a string is worth keeping. Longer ones are cut and marked. */
export const MAX_RECORDED_LENGTH = 200;

/**
 * Fragments of a column name that mean the value is a secret.
 *
 * Matched anywhere in the name, so `password_hash`, `refresh_token_hash` and
 * `device_token_hash` are all caught by the two entries that describe them,
 * and a column a later migration adds is caught without this list being
 * revisited.
 */
const SECRET_FRAGMENTS = [
  'password',
  'secret',
  'token',
  'credential',
  'api_key',
  'private_key',
] as const;

/**
 * The rows that belong to a child.
 *
 * A participant is a student, a team member is a student in a team, and a
 * submission is something a student sent in. What is written down about them
 * is narrower than what is written down about a teacher.
 */
const CHILD_ENTITY_TYPES: readonly AuditEntityType[] = [
  'participant',
  'submission',
];

/** Columns not recorded on a row that belongs to a child. */
const PERSONAL_COLUMNS = [
  'display_name',
  'full_name',
  'email',
  'avatar_url',
  'device_id',
  'payload',
] as const;

/** True when the column holds something that must never be written down. */
export function isSecretColumn(column: string): boolean {
  const name = column.toLowerCase();
  return SECRET_FRAGMENTS.some((fragment) => name.includes(fragment));
}

/** True when the column holds a detail about a child (EXPD-071). */
export function isPersonalColumn(entityType: AuditEntityType, column: string): boolean {
  return (
    CHILD_ENTITY_TYPES.includes(entityType) &&
    (PERSONAL_COLUMNS as readonly string[]).includes(column.toLowerCase())
  );
}

/** A row as it comes off the driver, before anything is decided about it. */
export type RowValues = Readonly<Record<string, unknown>>;

/** The two sides of a change, and the reason for it. */
export interface ChangeInput {
  /** The row as it was. Absent when the row is being created. */
  readonly before?: RowValues;
  /** The row as it now is. Absent when the row is being deleted. */
  readonly after?: RowValues;
  /** Why, in the actor's own words. Recorded as given, cut if it is long. */
  readonly note?: string;
}

/**
 * Turns a change into the entry's `changes` document.
 *
 * Only the columns that differ survive, and each surviving value goes through
 * the rules above. A change where nothing differs produces `{}`, which is
 * what the `audit_log_changes_is_object` constraint wants and what an entry
 * about an action that changed no column — a sign-in, a run being started —
 * should say.
 */
export function describeChange(
  entityType: AuditEntityType,
  change: ChangeInput,
): AuditChanges {
  const before: Record<string, AuditValue> = {};
  const after: Record<string, AuditValue> = {};

  for (const column of changedColumns(change.before, change.after)) {
    const hidden = isSecretColumn(column) || isPersonalColumn(entityType, column);

    if (change.before !== undefined && Object.hasOwn(change.before, column)) {
      before[column] = hidden ? REDACTED : recordable(change.before[column]);
    }
    if (change.after !== undefined && Object.hasOwn(change.after, column)) {
      after[column] = hidden ? REDACTED : recordable(change.after[column]);
    }
  }

  return {
    ...(Object.keys(before).length > 0 ? { before } : {}),
    ...(Object.keys(after).length > 0 ? { after } : {}),
    ...(change.note === undefined ? {} : { note: shorten(change.note) }),
  };
}

/**
 * The columns whose value is not the same on both sides.
 *
 * A column present on one side only counts as changed: that is what creating
 * and deleting a row look like.
 */
export function changedColumns(
  before: RowValues | undefined,
  after: RowValues | undefined,
): readonly string[] {
  const names = new Set([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
  ]);

  return [...names]
    .filter((column) => {
      if (before === undefined || after === undefined) {
        return true;
      }
      return !sameValue(before[column], after[column]);
    })
    .sort();
}

/**
 * Turns one value into something worth keeping forever.
 *
 * Scalars are kept as they are. A time becomes an ISO string, because that is
 * what a reader wants and what JSONB would store anyway. Everything with a
 * shape — an object, an array — becomes a marker: the entry says the column
 * changed, and the row itself is still the place to look for what it now
 * holds.
 */
export function recordable(value: unknown): AuditValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    // NaN and Infinity have no JSON spelling, so they become a marker rather
    // than turning the whole document into one the constraint would refuse.
    return Number.isFinite(value) ? value : NOT_RECORDED;
  }
  if (typeof value === 'string') {
    return shorten(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return NOT_RECORDED;
}

/** Cuts a long string short, and says that it was cut. */
function shorten(value: string): string {
  return value.length <= MAX_RECORDED_LENGTH
    ? value
    : `${value.slice(0, MAX_RECORDED_LENGTH)}…`;
}

/** Compares two column values the way the database would compare them. */
function sameValue(left: unknown, right: unknown): boolean {
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime();
  }
  if (left === null || left === undefined) {
    return right === null || right === undefined;
  }
  if (typeof left === 'object' || typeof right === 'object') {
    // Two documents are compared by their text, because the driver hands back
    // a fresh object each time and `===` would call every JSONB column changed.
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return left === right;
}

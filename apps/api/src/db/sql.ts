/**
 * Building parameterised statements.
 *
 * Small on purpose. This is not a query builder that wants to cover SQL; it
 * covers the shapes the repository layer needs so that the tenant predicate
 * can be attached to every one of them without the caller doing it by hand.
 *
 * A repository with a query too complicated for this writes the SQL itself
 * and asks `tenantPredicate` for the predicate to paste into it. The one
 * thing a repository must never do is write the WHERE clause from scratch and
 * remember to include the organisation.
 */

import { quoteIdentifier } from './tables.ts';

/** A value that can be bound to a parameter. */
export type SqlValue = string | number | boolean | Date | null | SqlValue[] | object;

/**
 * What a statement is matched against.
 *
 * A plain value means `=`. An array means `IN`, and an empty array means the
 * statement matches nothing. `null` means `IS NULL`.
 */
export type Filter = Readonly<Record<string, SqlValue | readonly SqlValue[]>>;

/**
 * Collects the values a statement binds, and hands out their placeholders.
 *
 * Every value in a statement goes through `bind`. Nothing is ever formatted
 * into the SQL text.
 */
export class Params {
  readonly #values: SqlValue[] = [];

  /** Records a value and returns the placeholder that stands for it. */
  bind(value: SqlValue): string {
    this.#values.push(value);
    return `$${this.#values.length}`;
  }

  /** The values, in the order their placeholders were handed out. */
  get values(): readonly SqlValue[] {
    return this.#values;
  }
}

/** A fragment of SQL that is always true. Used when a filter is empty. */
export const ALWAYS_TRUE = 'true';

/** A fragment of SQL that is never true. Used for `IN ()`. */
export const NEVER_TRUE = 'false';

/**
 * Turns a filter into `a = $1 AND b IN ($2, $3)`.
 *
 * `qualifier` prefixes each column, for a statement that joins.
 */
export function buildFilter(
  filter: Filter,
  params: Params,
  qualifier?: string,
): string {
  const clauses = Object.entries(filter).map(([column, value]) =>
    buildComparison(column, value, params, qualifier),
  );
  return clauses.length === 0 ? ALWAYS_TRUE : clauses.join(' AND ');
}

function buildComparison(
  column: string,
  value: SqlValue | readonly SqlValue[],
  params: Params,
  qualifier?: string,
): string {
  const name = qualifyColumn(column, qualifier);

  if (value === null) {
    return `${name} IS NULL`;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return NEVER_TRUE;
    }
    const placeholders = value.map((item) => params.bind(item as SqlValue));
    return `${name} IN (${placeholders.join(', ')})`;
  }

  return `${name} = ${params.bind(value as SqlValue)}`;
}

/** Quotes a column name, optionally behind a table alias. */
export function qualifyColumn(column: string, qualifier?: string): string {
  const quoted = quoteIdentifier(column);
  return qualifier === undefined ? quoted : `${quoteIdentifier(qualifier)}.${quoted}`;
}

/** Turns a list of column names into a select list, or `*` when empty. */
export function buildColumnList(
  columns: readonly string[] | undefined,
  qualifier?: string,
): string {
  if (columns === undefined || columns.length === 0) {
    return qualifier === undefined ? '*' : `${quoteIdentifier(qualifier)}.*`;
  }
  return columns.map((column) => qualifyColumn(column, qualifier)).join(', ');
}

/** Which way a result is sorted. */
export type SortDirection = 'asc' | 'desc';

/** One column to sort by. */
export interface Sort {
  readonly column: string;
  readonly direction?: SortDirection;
}

/** Turns a sort list into `ORDER BY "a" ASC, "b" DESC`, or an empty string. */
export function buildOrderBy(
  sorts: readonly Sort[] | undefined,
  qualifier?: string,
): string {
  if (sorts === undefined || sorts.length === 0) {
    return '';
  }
  const parts = sorts.map(
    (sort) =>
      `${qualifyColumn(sort.column, qualifier)} ${sort.direction === 'desc' ? 'DESC' : 'ASC'}`,
  );
  return ` ORDER BY ${parts.join(', ')}`;
}

/** Turns a row of values into the `(columns) VALUES (...)` half of an INSERT. */
export function buildInsertBody(
  values: Readonly<Record<string, SqlValue>>,
  params: Params,
): string {
  const columns = Object.keys(values);
  const names = columns.map((column) => quoteIdentifier(column)).join(', ');
  const placeholders = columns
    .map((column) => params.bind(values[column] as SqlValue))
    .join(', ');
  return `(${names}) VALUES (${placeholders})`;
}

/** Turns a patch into `"a" = $1, "b" = $2`. */
export function buildAssignments(
  patch: Readonly<Record<string, SqlValue>>,
  params: Params,
): string {
  return Object.entries(patch)
    .map(([column, value]) => `${quoteIdentifier(column)} = ${params.bind(value)}`)
    .join(', ');
}

/**
 * A database that keeps its rows in memory (EXPD-005).
 *
 * The isolation tests need to watch a real row *not* come back. A fake that
 * only records statements cannot show that: it would prove the SQL contains
 * the word `organisation_id` and nothing more. So this one stores rows and
 * runs the statements against them, and a leak shows up as a row in a result
 * rather than as a missing substring.
 *
 * It understands exactly the statements `TenantRepository` and
 * `GlobalRepository` build, and no more. That grammar is short and it is
 * written down in one place, `src/db/sql.ts`:
 *
 *   SELECT <columns> FROM "t" WHERE <where> [ORDER BY] [LIMIT] [OFFSET] [FOR UPDATE]
 *   SELECT count(*)::bigint AS count FROM "t" WHERE <where>
 *   INSERT INTO "t" ("a", "b") VALUES ($1, $2) RETURNING *
 *   UPDATE "t" SET "a" = $1 WHERE <where> RETURNING *
 *   DELETE FROM "t" WHERE <where>
 *
 * where `<where>` is `true`, `false`, or `AND`-joined comparisons of the form
 * `"c" = $n`, `"c" IS NULL`, `"c" IN ($a, $b)`, and the shared-row predicate
 * `("organisation_id" = $n OR "organisation_id" IS NULL)`.
 *
 * A statement outside that grammar throws rather than being ignored, because
 * a test that quietly matched nothing would pass for the wrong reason.
 *
 * The store itself knows nothing about organisations. It does not filter, it
 * does not check a predicate, and it will happily hand back another
 * organisation's row if a statement asks for it. That is the point: every
 * bit of the isolation being tested has to come from the code under test.
 */

import type { Queryable, QueryResult, QueryResultRow } from '../../src/db/queryable.ts';

/** One row, as loosely typed as the store that holds it. */
export type FakeRow = Record<string, unknown>;

/** A statement the fake was asked to run. */
export interface RecordedStatement {
  readonly text: string;
  readonly values: readonly unknown[];
}

/** Thrown when a statement is outside the grammar this fake understands. */
export class UnsupportedStatementError extends Error {
  override readonly name = 'UnsupportedStatementError';

  constructor(text: string) {
    super(
      `The in-memory database was given a statement it does not understand:\n  ${text}\n` +
        'Either the repository layer now builds a new shape, or the test wrote ' +
        'SQL by hand. Teach the fake the shape, or use RecordingDatabase instead.',
    );
  }
}

/** Rows in memory, and the statements that were run against them. */
export class FakeDatabase implements Queryable {
  readonly #tables = new Map<string, FakeRow[]>();
  readonly #statements: RecordedStatement[] = [];
  #nextId = 1;

  /** Puts rows in a table. Copies them, so a test cannot change them later. */
  seed(table: string, ...rows: readonly FakeRow[]): void {
    const stored = this.#tables.get(table) ?? [];
    for (const row of rows) {
      stored.push({ ...row });
    }
    this.#tables.set(table, stored);
  }

  /** Every row a table holds, as copies. The state a test asserts against. */
  rowsIn(table: string): readonly FakeRow[] {
    return (this.#tables.get(table) ?? []).map((row) => ({ ...row }));
  }

  /** Every statement that has been run, oldest first. */
  get statements(): readonly RecordedStatement[] {
    return this.#statements;
  }

  /** The statement run most recently. Throws when nothing has run. */
  get lastStatement(): RecordedStatement {
    const last = this.#statements.at(-1);
    if (last === undefined) {
      throw new Error('No statement has been run against this database yet.');
    }
    return last;
  }

  /** Forgets the recorded statements. The rows stay. */
  forgetStatements(): void {
    this.#statements.length = 0;
  }

  async query<TRow extends QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<TRow>> {
    this.#statements.push({ text, values });
    const result = this.#run(text, values);
    return { rows: result.rows as TRow[], rowCount: result.rowCount };
  }

  #run(text: string, values: readonly unknown[]): { rows: FakeRow[]; rowCount: number } {
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
      return { rows: [], rowCount: 0 };
    }
    if (text.startsWith('SELECT ')) {
      return this.#select(text, values);
    }
    if (text.startsWith('INSERT INTO ')) {
      return this.#insert(text, values);
    }
    if (text.startsWith('UPDATE ')) {
      return this.#update(text, values);
    }
    if (text.startsWith('DELETE FROM ')) {
      return this.#delete(text, values);
    }
    throw new UnsupportedStatementError(text);
  }

  #select(text: string, values: readonly unknown[]): { rows: FakeRow[]; rowCount: number } {
    const parsed = /^SELECT (?<columns>.+?) FROM "(?<table>[a-z_]+)"(?<rest>.*)$/s.exec(
      text,
    );
    if (parsed?.groups === undefined) {
      throw new UnsupportedStatementError(text);
    }
    const { columns, table, rest } = parsed.groups as {
      columns: string;
      table: string;
      rest: string;
    };

    const clauses = readClauses(rest, text);
    let rows = this.#matching(table, clauses.where, values, text);

    if (clauses.orderBy !== undefined) {
      rows = sortRows(rows, clauses.orderBy);
    }
    if (clauses.offset !== undefined) {
      rows = rows.slice(asCount(bind(clauses.offset, values, text)));
    }
    if (clauses.limit !== undefined) {
      rows = rows.slice(0, asCount(bind(clauses.limit, values, text)));
    }

    if (columns === 'count(*)::bigint AS count') {
      return { rows: [{ count: String(rows.length) }], rowCount: 1 };
    }
    const projected = rows.map((row) => project(row, columns, text));
    return { rows: projected, rowCount: projected.length };
  }

  #insert(text: string, values: readonly unknown[]): { rows: FakeRow[]; rowCount: number } {
    const parsed =
      /^INSERT INTO "(?<table>[a-z_]+)" \((?<columns>.*?)\) VALUES \((?<placeholders>.*?)\) RETURNING \*$/s.exec(
        text,
      );
    if (parsed?.groups === undefined) {
      throw new UnsupportedStatementError(text);
    }
    const { table, columns, placeholders } = parsed.groups as {
      table: string;
      columns: string;
      placeholders: string;
    };

    const names = columns.split(', ').map((name) => unquote(name, text));
    const bound = placeholders.split(', ').map((token) => bind(token, values, text));
    if (names.length !== bound.length) {
      throw new UnsupportedStatementError(text);
    }

    const row: FakeRow = {};
    names.forEach((name, index) => {
      row[name] = bound[index];
    });
    row['id'] ??= `fake-${this.#nextId++}`;

    const stored = this.#tables.get(table) ?? [];
    stored.push(row);
    this.#tables.set(table, stored);

    return { rows: [{ ...row }], rowCount: 1 };
  }

  #update(text: string, values: readonly unknown[]): { rows: FakeRow[]; rowCount: number } {
    const parsed =
      /^UPDATE "(?<table>[a-z_]+)" SET (?<assignments>.+?) WHERE (?<where>.+) RETURNING \*$/s.exec(
        text,
      );
    if (parsed?.groups === undefined) {
      throw new UnsupportedStatementError(text);
    }
    const { table, assignments, where } = parsed.groups as {
      table: string;
      assignments: string;
      where: string;
    };

    const patch = assignments.split(', ').map((assignment) => {
      const split = /^"(?<column>[a-z_]+)" = (?<token>\$\d+)$/.exec(assignment);
      if (split?.groups === undefined) {
        throw new UnsupportedStatementError(text);
      }
      return {
        column: split.groups['column'] as string,
        value: bind(split.groups['token'] as string, values, text),
      };
    });

    const matched = this.#matching(table, where, values, text);
    for (const row of matched) {
      for (const assignment of patch) {
        row[assignment.column] = assignment.value;
      }
    }
    return { rows: matched.map((row) => ({ ...row })), rowCount: matched.length };
  }

  #delete(text: string, values: readonly unknown[]): { rows: FakeRow[]; rowCount: number } {
    const parsed = /^DELETE FROM "(?<table>[a-z_]+)" WHERE (?<where>.+)$/s.exec(text);
    if (parsed?.groups === undefined) {
      throw new UnsupportedStatementError(text);
    }
    const { table, where } = parsed.groups as { table: string; where: string };

    const stored = this.#tables.get(table) ?? [];
    const matches = compileWhere(where, values, text);
    const kept = stored.filter((row) => !matches(row));
    const removed = stored.length - kept.length;
    this.#tables.set(table, kept);

    return { rows: [], rowCount: removed };
  }

  /** The live rows a WHERE clause matches, not copies: `#update` writes to them. */
  #matching(
    table: string,
    where: string | undefined,
    values: readonly unknown[],
    text: string,
  ): FakeRow[] {
    const stored = this.#tables.get(table) ?? [];
    if (where === undefined) {
      throw new UnsupportedStatementError(text);
    }
    const matches = compileWhere(where, values, text);
    return stored.filter((row) => matches(row));
  }
}

/** Whether a row satisfies a clause. */
type RowPredicate = (row: FakeRow) => boolean;

/** The clauses that can follow the table name in a SELECT. */
interface SelectClauses {
  readonly where?: string;
  readonly orderBy?: string;
  readonly limit?: string;
  readonly offset?: string;
}

const SELECT_TAILS = [' ORDER BY ', ' LIMIT ', ' OFFSET ', ' FOR UPDATE'] as const;

/**
 * Splits everything after the table name into its clauses.
 *
 * Splitting on the keyword is safe here because a WHERE clause built by
 * `sql.ts` holds nothing but quoted identifiers and `$n` placeholders — no
 * value is ever formatted into the text, so none of these words can appear
 * inside one.
 */
function readClauses(rest: string, text: string): SelectClauses {
  if (rest === '') {
    return {};
  }
  if (!rest.startsWith(' WHERE ')) {
    throw new UnsupportedStatementError(text);
  }

  let remainder = rest.slice(' WHERE '.length);
  const clauses: { -readonly [TKey in keyof SelectClauses]: string | undefined } = {};

  const cut = cutAtFirst(remainder, SELECT_TAILS);
  clauses.where = cut.head;
  remainder = cut.tail;

  while (remainder !== '') {
    if (remainder === ' FOR UPDATE') {
      break;
    }
    const next = readKeyedClause(remainder, text);
    if (next.keyword === ' ORDER BY ') {
      clauses.orderBy = next.value;
    } else if (next.keyword === ' LIMIT ') {
      clauses.limit = next.value;
    } else {
      clauses.offset = next.value;
    }
    remainder = next.rest;
  }

  return clauses;
}

function readKeyedClause(
  remainder: string,
  text: string,
): { keyword: string; value: string; rest: string } {
  for (const keyword of [' ORDER BY ', ' LIMIT ', ' OFFSET '] as const) {
    if (remainder.startsWith(keyword)) {
      const cut = cutAtFirst(remainder.slice(keyword.length), SELECT_TAILS);
      return { keyword, value: cut.head, rest: cut.tail };
    }
  }
  throw new UnsupportedStatementError(text);
}

function cutAtFirst(
  text: string,
  markers: readonly string[],
): { head: string; tail: string } {
  let index = -1;
  for (const marker of markers) {
    const found = text.indexOf(marker);
    if (found !== -1 && (index === -1 || found < index)) {
      index = found;
    }
  }
  return index === -1
    ? { head: text, tail: '' }
    : { head: text.slice(0, index), tail: text.slice(index) };
}

/** Turns a WHERE clause into a predicate. */
function compileWhere(
  where: string,
  values: readonly unknown[],
  text: string,
): RowPredicate {
  const conjuncts = where.split(' AND ').map((part) => compileConjunct(part.trim(), values, text));
  return (row) => conjuncts.every((matches) => matches(row));
}

function compileConjunct(
  clause: string,
  values: readonly unknown[],
  text: string,
): RowPredicate {
  if (clause === 'true') {
    return () => true;
  }
  if (clause === 'false') {
    return () => false;
  }
  if (clause.startsWith('(') && clause.endsWith(')')) {
    const alternatives = clause
      .slice(1, -1)
      .split(' OR ')
      .map((part) => compileComparison(part.trim(), values, text));
    return (row) => alternatives.some((matches) => matches(row));
  }
  return compileComparison(clause, values, text);
}

/** `"a"."c"` or `"c"`. The qualifier is dropped: the fake joins nothing. */
const COLUMN = '(?:"[a-z_]+"\\.)?"(?<column>[a-z_]+)"';

function compileComparison(
  clause: string,
  values: readonly unknown[],
  text: string,
): RowPredicate {
  const isNull = new RegExp(`^${COLUMN} IS NULL$`).exec(clause);
  if (isNull?.groups !== undefined) {
    const column = isNull.groups['column'] as string;
    return (row) => (row[column] ?? null) === null;
  }

  const inList = new RegExp(`^${COLUMN} IN \\((?<tokens>\\$\\d+(?:, \\$\\d+)*)\\)$`).exec(
    clause,
  );
  if (inList?.groups !== undefined) {
    const column = inList.groups['column'] as string;
    const wanted = (inList.groups['tokens'] as string)
      .split(', ')
      .map((token) => bind(token, values, text));
    return (row) => wanted.some((value) => sameValue(row[column], value));
  }

  const equals = new RegExp(`^${COLUMN} = (?<token>\\$\\d+)$`).exec(clause);
  if (equals?.groups !== undefined) {
    const column = equals.groups['column'] as string;
    const wanted = bind(equals.groups['token'] as string, values, text);
    return (row) => sameValue(row[column], wanted);
  }

  throw new UnsupportedStatementError(text);
}

/** Reads the value a `$n` placeholder stands for. */
function bind(token: string, values: readonly unknown[], text: string): unknown {
  const match = /^\$(?<index>\d+)$/.exec(token);
  if (match?.groups === undefined) {
    throw new UnsupportedStatementError(text);
  }
  const index = Number(match.groups['index']) - 1;
  if (index < 0 || index >= values.length) {
    throw new Error(
      `Statement refers to ${token} but only ${values.length} value(s) were bound:\n  ${text}`,
    );
  }
  return values[index];
}

/** Compares two bound values the way PostgreSQL would compare two columns. */
function sameValue(left: unknown, right: unknown): boolean {
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime();
  }
  if (left === undefined || right === undefined) {
    return false;
  }
  return left === right;
}

function project(row: FakeRow, columns: string, text: string): FakeRow {
  if (columns === '*') {
    return { ...row };
  }
  const picked: FakeRow = {};
  for (const name of columns.split(', ')) {
    const column = unquote(name, text);
    picked[column] = row[column] ?? null;
  }
  return picked;
}

function unquote(name: string, text: string): string {
  const match = /^"(?<column>[a-z_]+)"$/.exec(name.trim());
  if (match?.groups === undefined) {
    throw new UnsupportedStatementError(text);
  }
  return match.groups['column'] as string;
}

function sortRows(rows: readonly FakeRow[], orderBy: string): FakeRow[] {
  const terms = orderBy.split(', ').map((term) => {
    const match = new RegExp(`^${COLUMN} (?<direction>ASC|DESC)$`).exec(term);
    if (match?.groups === undefined) {
      throw new UnsupportedStatementError(orderBy);
    }
    return {
      column: match.groups['column'] as string,
      descending: match.groups['direction'] === 'DESC',
    };
  });

  return [...rows].sort((left, right) => {
    for (const term of terms) {
      const order = compareValues(left[term.column], right[term.column]);
      if (order !== 0) {
        return term.descending ? -order : order;
      }
    }
    return 0;
  });
}

function compareValues(left: unknown, right: unknown): number {
  const a = left instanceof Date ? left.getTime() : left;
  const b = right instanceof Date ? right.getTime() : right;
  if (a === b) {
    return 0;
  }
  if (a === null || a === undefined) {
    return 1;
  }
  if (b === null || b === undefined) {
    return -1;
  }
  return (a as never) < (b as never) ? -1 : 1;
}

function asCount(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

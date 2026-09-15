/**
 * Row-level tenant isolation (EXPD-004).
 *
 * The rule the platform rests on: a request acting for one organisation can
 * never read or change a row belonging to another. EXPD-003 made that
 * checkable by putting `organisation_id` on every table an organisation owns,
 * even where a join could have reached it. This class is what does the
 * checking.
 *
 * The idea is that isolation should not be something a developer remembers.
 * A repository built here cannot be constructed without an organisation, and
 * every statement it builds carries the predicate whether the caller asked
 * for it or not:
 *
 *   - a read is `... WHERE organisation_id = $1 AND <the caller's filter>`
 *   - an insert sets `organisation_id` itself, and refuses a different one
 *   - an update and a delete carry the predicate, and an update may not move
 *     a row to another organisation
 *   - a table with no `organisation_id` throws rather than running unscoped
 *
 * There are two deliberate ways round it, and both are loud. `TenantScope`
 * with `includeSharedRows` widens *reads* to the platform-wide rows in
 * `mission_type`, `mission_template` and `badge`, which is what "every
 * organisation may use the QR hunt type" means. It never widens a write: an
 * organisation may read the QR hunt type and may not edit it.
 * `GlobalRepository` in `./global-repository.ts` reaches the tables that
 * belong to nobody, and makes the caller write down why.
 *
 * What this class does not do is decide whether the caller may make the call
 * at all. That is the permission check in `@explorer/shared-types`. A
 * facilitator reading their own organisation's expeditions passes the
 * isolation check and fails the permission check for editing one. Both run.
 */

import type { OrganisationId } from '@explorer/shared-types';

import { CrossTenantWriteError } from './errors.ts';
import type { Queryable, QueryResultRow } from './queryable.ts';
import {
  assertTenantScoped,
  quoteIdentifier,
  scopeOf,
  type TenantTableName,
} from './tables.ts';
import {
  buildAssignments,
  buildColumnList,
  buildFilter,
  buildInsertBody,
  buildOrderBy,
  Params,
  type Filter,
  type Sort,
  type SqlValue,
} from './sql.ts';

/** The column every tenant-scoped table carries. */
export const TENANT_COLUMN = 'organisation_id';

/** The organisation a repository acts for. */
export interface TenantScope {
  readonly organisationId: OrganisationId;
  /**
   * Whether reads also return the platform-wide rows — the ones with a NULL
   * `organisation_id` in `mission_type`, `mission_template` and `badge`.
   *
   * Off by default. A caller listing the mission types an author may pick
   * from turns it on; a caller listing the types this organisation built
   * leaves it off. It never affects a write.
   */
  readonly includeSharedRows?: boolean;
}

/** What to read. */
export interface FindOptions {
  /** Matched with AND. Empty matches every row in the organisation. */
  readonly where?: Filter;
  /** Which columns to read. Every column when absent. */
  readonly columns?: readonly string[];
  readonly orderBy?: readonly Sort[];
  readonly limit?: number;
  readonly offset?: number;
  /** Takes `FOR UPDATE` on the rows read. Only inside a transaction. */
  readonly forUpdate?: boolean;
}

/**
 * A repository pinned to one organisation.
 *
 * Extend it for a table, or use it as it is. Either way the organisation is
 * fixed when it is built and cannot be changed afterwards.
 */
export class TenantRepository {
  readonly #db: Queryable;
  readonly #scope: TenantScope;

  constructor(db: Queryable, scope: TenantScope) {
    this.#db = db;
    this.#scope = scope;
  }

  /** The organisation every statement is filtered by. */
  get organisationId(): OrganisationId {
    return this.#scope.organisationId;
  }

  /** The same repository against a different connection, such as a transaction. */
  withConnection(db: Queryable): TenantRepository {
    return new TenantRepository(db, this.#scope);
  }

  /**
   * The isolation predicate for a read, for a statement written by hand.
   *
   * A repository whose query is beyond `find` writes its own SQL and pastes
   * this into the WHERE clause. It is the supported way to write a join: ask
   * for the predicate rather than typing `organisation_id = $1` and hoping.
   *
   *     const params = new Params();
   *     const scoped = repository.readPredicate('team', params, 't');
   *     const sql = `SELECT t.* FROM team t
   *                  JOIN participant p ON p.team_id = t.id
   *                  WHERE ${scoped}`;
   *
   * When the scope was built with `includeSharedRows`, this also matches the
   * platform-wide rows. Use `writePredicate` for anything that changes a row:
   * reading the QR hunt mission type is not permission to edit it.
   */
  readPredicate(table: string, params: Params, qualifier?: string): string {
    const name = assertTenantScoped(table);
    return this.#buildPredicate(params, qualifier, this.#sharedRowsVisible(name));
  }

  /**
   * The isolation predicate for a write, for a statement written by hand.
   *
   * Always `organisation_id = $n`, and never widened. A platform-wide row
   * belongs to the platform: an organisation may read one and may not change
   * it, whatever its scope was built with.
   */
  writePredicate(table: string, params: Params, qualifier?: string): string {
    assertTenantScoped(table);
    return this.#buildPredicate(params, qualifier, false);
  }

  #buildPredicate(
    params: Params,
    qualifier: string | undefined,
    includeShared: boolean,
  ): string {
    const column =
      qualifier === undefined
        ? quoteIdentifier(TENANT_COLUMN)
        : `${quoteIdentifier(qualifier)}.${quoteIdentifier(TENANT_COLUMN)}`;
    const placeholder = params.bind(this.#scope.organisationId);

    return includeShared
      ? `(${column} = ${placeholder} OR ${column} IS NULL)`
      : `${column} = ${placeholder}`;
  }

  /** Reads rows from one table. */
  async find<TRow extends QueryResultRow>(
    table: TenantTableName,
    options: FindOptions = {},
  ): Promise<TRow[]> {
    const name = assertTenantScoped(table);
    const params = new Params();

    const columns = buildColumnList(options.columns);
    const scoped = this.readPredicate(name, params);
    const caller = buildFilter(options.where ?? {}, params);

    let sql =
      `SELECT ${columns} FROM ${quoteIdentifier(name)}` +
      ` WHERE ${scoped} AND ${caller}` +
      buildOrderBy(options.orderBy);

    if (options.limit !== undefined) {
      sql += ` LIMIT ${params.bind(options.limit)}`;
    }
    if (options.offset !== undefined) {
      sql += ` OFFSET ${params.bind(options.offset)}`;
    }
    if (options.forUpdate === true) {
      sql += ' FOR UPDATE';
    }

    const result = await this.#db.query<TRow>(sql, params.values);
    return result.rows;
  }

  /** Reads one row, or null. Takes the first when the filter matches several. */
  async findOne<TRow extends QueryResultRow>(
    table: TenantTableName,
    options: FindOptions = {},
  ): Promise<TRow | null> {
    const rows = await this.find<TRow>(table, { ...options, limit: 1 });
    return rows[0] ?? null;
  }

  /** Reads one row by its primary key, or null. */
  async findById<TRow extends QueryResultRow>(
    table: TenantTableName,
    id: string,
    options: Omit<FindOptions, 'where' | 'limit' | 'offset'> = {},
  ): Promise<TRow | null> {
    return this.findOne<TRow>(table, { ...options, where: { id } });
  }

  /** Counts the rows a filter matches. */
  async count(table: TenantTableName, where: Filter = {}): Promise<number> {
    const name = assertTenantScoped(table);
    const params = new Params();
    const scoped = this.readPredicate(name, params);
    const caller = buildFilter(where, params);

    const sql =
      `SELECT count(*)::bigint AS count FROM ${quoteIdentifier(name)}` +
      ` WHERE ${scoped} AND ${caller}`;

    const result = await this.#db.query<{ count: string }>(sql, params.values);
    return Number(result.rows[0]?.count ?? 0);
  }

  /** Returns true when at least one row matches. */
  async exists(table: TenantTableName, where: Filter = {}): Promise<boolean> {
    const rows = await this.find(table, { where, columns: ['id'], limit: 1 });
    return rows.length > 0;
  }

  /**
   * Inserts one row and returns it.
   *
   * `organisation_id` is set from the scope. Passing it is allowed, and
   * passing a different one throws: that is the mistake this whole file
   * exists to catch.
   */
  async insert<TRow extends QueryResultRow>(
    table: TenantTableName,
    values: Readonly<Record<string, SqlValue>>,
  ): Promise<TRow> {
    const name = assertTenantScoped(table);
    const row = { ...values, [TENANT_COLUMN]: this.#assertOwnOrganisation(name, values) };

    const params = new Params();
    const sql =
      `INSERT INTO ${quoteIdentifier(name)} ${buildInsertBody(row, params)}` +
      ' RETURNING *';

    const result = await this.#db.query<TRow>(sql, params.values);
    const inserted = result.rows[0];
    if (inserted === undefined) {
      throw new Error(`INSERT INTO ${name} returned no row.`);
    }
    return inserted;
  }

  /**
   * Changes every row a filter matches, and returns them.
   *
   * The organisation predicate is added to the filter, so a row belonging to
   * somebody else is not matched and not changed. A patch that sets
   * `organisation_id` to another organisation throws: moving a row between
   * tenants is not an update, and nothing in the platform does it.
   */
  async update<TRow extends QueryResultRow>(
    table: TenantTableName,
    where: Filter,
    patch: Readonly<Record<string, SqlValue>>,
  ): Promise<TRow[]> {
    const name = assertTenantScoped(table);
    if (Object.keys(patch).length === 0) {
      throw new Error(`UPDATE ${name} was given nothing to change.`);
    }
    this.#assertOwnOrganisation(name, patch);

    const params = new Params();
    const assignments = buildAssignments(patch, params);
    const scoped = this.writePredicate(name, params);
    const caller = buildFilter(where, params);

    const sql =
      `UPDATE ${quoteIdentifier(name)} SET ${assignments}` +
      ` WHERE ${scoped} AND ${caller} RETURNING *`;

    const result = await this.#db.query<TRow>(sql, params.values);
    return result.rows;
  }

  /** Changes one row by its primary key, and returns it, or null if it is not ours. */
  async updateById<TRow extends QueryResultRow>(
    table: TenantTableName,
    id: string,
    patch: Readonly<Record<string, SqlValue>>,
  ): Promise<TRow | null> {
    const rows = await this.update<TRow>(table, { id }, patch);
    return rows[0] ?? null;
  }

  /** Deletes every row a filter matches, and returns how many went. */
  async delete(table: TenantTableName, where: Filter): Promise<number> {
    const name = assertTenantScoped(table);
    const params = new Params();
    const scoped = this.writePredicate(name, params);
    const caller = buildFilter(where, params);

    const sql =
      `DELETE FROM ${quoteIdentifier(name)} WHERE ${scoped} AND ${caller}`;

    const result = await this.#db.query(sql, params.values);
    return result.rowCount ?? 0;
  }

  /**
   * Runs a statement the caller wrote, having checked it mentions the tenant
   * column.
   *
   * The escape hatch for a query `find` cannot express. It is not a way round
   * isolation: the caller still has to build the predicate with
   * `readPredicate` or `writePredicate`, and this refuses a statement that
   * does not carry it.
   * The check is a guard rail against a forgotten predicate, not a parser —
   * it cannot tell a predicate in the wrong place from one in the right one.
   */
  async queryScoped<TRow extends QueryResultRow>(
    sql: string,
    params: Params,
  ): Promise<TRow[]> {
    if (!sql.includes(TENANT_COLUMN)) {
      throw new CrossTenantWriteError(
        'a hand-written statement',
        this.#scope.organisationId,
        'no organisation at all',
      );
    }
    const result = await this.#db.query<TRow>(sql, params.values);
    return result.rows;
  }

  /**
   * Checks the `organisation_id` in a set of values, and returns the one to
   * use. Absent means the scope's own.
   */
  #assertOwnOrganisation(
    table: string,
    values: Readonly<Record<string, SqlValue>>,
  ): OrganisationId {
    const given = values[TENANT_COLUMN];
    if (given !== undefined && given !== this.#scope.organisationId) {
      throw new CrossTenantWriteError(
        table,
        this.#scope.organisationId,
        given === null ? 'none' : String(given),
      );
    }
    return this.#scope.organisationId;
  }

  /** True when this read should also return the platform-wide rows. */
  #sharedRowsVisible(table: TenantTableName): boolean {
    return (
      this.#scope.includeSharedRows === true && scopeOf(table) === 'tenant-or-shared'
    );
  }
}

/** Builds a repository for one organisation. */
export function tenantRepository(
  db: Queryable,
  scope: TenantScope,
): TenantRepository {
  return new TenantRepository(db, scope);
}

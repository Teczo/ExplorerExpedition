/**
 * The tables that belong to nobody (EXPD-004).
 *
 * Four tables in the schema have no `organisation_id`, and they have none for
 * a reason rather than by oversight:
 *
 *   `organisation`     is the tenant. It cannot be scoped to itself.
 *   `app_user`         is a person, and a person is not owned by a school.
 *                      The same teacher can work for two, which is what
 *                      `membership` is for.
 *   `user_credential`  is that person's password.
 *   `auth_session`     is that person's sign-in, which exists before they
 *                      have picked an organisation to act for.
 *
 * Reaching them is unavoidable — signing in means reading a user by email
 * before there is any organisation to scope to. What this class adds is that
 * the reach has to be written down. Every call takes a `reason`, which is a
 * sentence the next reader can check, and which the audit log (EXPD-006) can
 * record.
 *
 * Nothing else should ever be read through here. `assertGlobal` throws if it
 * is.
 */

import type { Queryable, QueryResultRow } from './queryable.ts';
import { assertGlobal, quoteIdentifier, type GlobalTableName } from './tables.ts';
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

/** Why a read is allowed to happen outside any organisation. */
export interface GlobalAccess {
  /**
   * A sentence a reviewer can check, such as
   * `'sign-in: find the account for the email that was offered'`.
   *
   * It is not validated, and the repository does not read it, because no
   * check could tell a true reason from a false one. It is there so that
   * every crossing is greppable and every one has an author who had to write
   * something down. EXPD-006 is what will record it.
   */
  readonly reason: string;
}

/** What to read from a global table. */
export interface GlobalFindOptions extends GlobalAccess {
  readonly where?: Filter;
  readonly columns?: readonly string[];
  readonly orderBy?: readonly Sort[];
  readonly limit?: number;
  readonly offset?: number;
  readonly forUpdate?: boolean;
}

/** Reads and writes the tables that belong to no organisation. */
export class GlobalRepository {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  /** The same repository against a different connection, such as a transaction. */
  withConnection(db: Queryable): GlobalRepository {
    return new GlobalRepository(db);
  }

  /** Reads rows from a global table. */
  async find<TRow extends QueryResultRow>(
    table: GlobalTableName,
    options: GlobalFindOptions,
  ): Promise<TRow[]> {
    const name = assertGlobal(table);
    const params = new Params();

    let sql =
      `SELECT ${buildColumnList(options.columns)} FROM ${quoteIdentifier(name)}` +
      ` WHERE ${buildFilter(options.where ?? {}, params)}` +
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

  /** Reads one row from a global table, or null. */
  async findOne<TRow extends QueryResultRow>(
    table: GlobalTableName,
    options: GlobalFindOptions,
  ): Promise<TRow | null> {
    const rows = await this.find<TRow>(table, { ...options, limit: 1 });
    return rows[0] ?? null;
  }

  /** Inserts one row into a global table and returns it. */
  async insert<TRow extends QueryResultRow>(
    table: GlobalTableName,
    values: Readonly<Record<string, SqlValue>>,
    _access: GlobalAccess,
  ): Promise<TRow> {
    const name = assertGlobal(table);
    const params = new Params();
    const sql =
      `INSERT INTO ${quoteIdentifier(name)} ${buildInsertBody(values, params)}` +
      ' RETURNING *';

    const result = await this.#db.query<TRow>(sql, params.values);
    const inserted = result.rows[0];
    if (inserted === undefined) {
      throw new Error(`INSERT INTO ${name} returned no row.`);
    }
    return inserted;
  }

  /** Changes rows in a global table and returns them. */
  async update<TRow extends QueryResultRow>(
    table: GlobalTableName,
    where: Filter,
    patch: Readonly<Record<string, SqlValue>>,
    _access: GlobalAccess,
  ): Promise<TRow[]> {
    const name = assertGlobal(table);
    if (Object.keys(patch).length === 0) {
      throw new Error(`UPDATE ${name} was given nothing to change.`);
    }

    const params = new Params();
    const sql =
      `UPDATE ${quoteIdentifier(name)} SET ${buildAssignments(patch, params)}` +
      ` WHERE ${buildFilter(where, params)} RETURNING *`;

    const result = await this.#db.query<TRow>(sql, params.values);
    return result.rows;
  }

  /** Deletes rows from a global table and returns how many went. */
  async delete(
    table: GlobalTableName,
    where: Filter,
    _access: GlobalAccess,
  ): Promise<number> {
    const name = assertGlobal(table);
    const params = new Params();
    const sql =
      `DELETE FROM ${quoteIdentifier(name)} WHERE ${buildFilter(where, params)}`;

    const result = await this.#db.query(sql, params.values);
    return result.rowCount ?? 0;
  }
}

/** Builds a repository for the tables that belong to no organisation. */
export function globalRepository(db: Queryable): GlobalRepository {
  return new GlobalRepository(db);
}

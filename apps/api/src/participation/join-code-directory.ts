/**
 * Turning a join code into the run it belongs to (EXPD-018).
 *
 * This is the one read in the ticket that is not scoped to an organisation,
 * and it is worth being blunt about why.
 *
 * A student opens the app and types six characters. They have no account, no
 * token, and no idea which school the API thinks they are in — that is the
 * whole point of a join code. So the lookup that turns the code into a run
 * cannot be given an organisation, because there is nowhere for one to come
 * from. Migration 0001 says the same thing in its own way: the unique index
 * on `join_code` is not scoped to an organisation either, which is what makes
 * a code unique across the platform rather than only inside one school.
 *
 * It is the same shape as signing in. `AuthService` reads `app_user` by email
 * before there is any organisation to scope to, and then everything after
 * that point is scoped to the organisation it found. Joining does exactly
 * that with a code instead of an email: this class finds the organisation,
 * and every other statement in the ticket goes through a `TenantRepository`
 * pinned to it.
 *
 * Four things keep the crossing narrow, and all four are on purpose.
 *
 *   1. **It reads two columns.** `id` and `organisation_id`, and nothing
 *      else. A caller cannot learn the name of a run, who is hosting it, or
 *      which expedition it plays, because this never reads any of that. The
 *      run itself is read afterwards, through a scoped repository.
 *   2. **It reads one table.** `expedition_session`, and no other.
 *   3. **It only sees joinable runs.** The status filter is the same four
 *      states as the index, so a code cannot reach a run that has ended.
 *   4. **Every method takes a reason**, the way `GlobalRepository` does, so
 *      that a new caller has to write down why it is allowed to cross.
 *
 * What it deliberately does not do is give anybody a way to read a run they
 * do not have a code for. A caller has to know the six characters, and a
 * wrong guess is answered with `null` and nothing else.
 */

import type { OrganisationId } from '@explorer/shared-types';
import { JOINABLE_SESSION_STATUSES } from '@explorer/shared-types';

import { buildColumnList, buildFilter, Params } from '../db/sql.ts';
import type { Queryable } from '../db/queryable.ts';
import { quoteIdentifier } from '../db/tables.ts';

/** The table this file reads, and the only one it may. */
const TABLE = 'expedition_session';

/** The two columns a code is allowed to reveal. */
const COLUMNS: readonly string[] = ['id', 'organisation_id'];

/** Why a read is allowed to happen outside any organisation. */
export interface DirectoryAccess {
  /**
   * A sentence a reviewer can check, such as
   * `'join: a student typing a code has no organisation to be scoped to'`.
   *
   * Not validated and not read, for the reason `GlobalRepository` gives: no
   * check could tell a true reason from a false one. It is here so that every
   * crossing is greppable and every one had an author who wrote something
   * down.
   */
  readonly reason: string;
}

/** Which run a code belongs to, and which organisation owns it. */
export interface JoinCodeMatch {
  readonly expeditionSessionId: string;
  readonly organisationId: OrganisationId;
}

/** The row this file reads, which is two columns wide. */
interface DirectoryRow {
  readonly id: string;
  readonly organisation_id: string;
}

/** Join codes, across every organisation. */
export class JoinCodeDirectory {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  /** The same directory against a different connection, such as a transaction. */
  withConnection(db: Queryable): JoinCodeDirectory {
    return new JoinCodeDirectory(db);
  }

  /**
   * The joinable run a code belongs to, or null.
   *
   * The code is matched exactly. Normalising what somebody typed is
   * `normaliseJoinCode`'s job and happens before this is called, so that this
   * method has one definition of a match and not two.
   */
  async findJoinableSession(
    joinCode: string,
    _access: DirectoryAccess,
  ): Promise<JoinCodeMatch | null> {
    const row = await this.#firstMatching(joinCode);
    if (row === null) {
      return null;
    }
    return {
      expeditionSessionId: row.id,
      organisationId: row.organisation_id as OrganisationId,
    };
  }

  /**
   * Whether a code is already in use by a joinable run.
   *
   * What `allocateJoinCode` asks before it hands a code to a new run. It
   * answers a yes or a no and never a row, so allocating a code cannot be
   * turned into a way of reading one.
   */
  async isJoinCodeTaken(joinCode: string, _access: DirectoryAccess): Promise<boolean> {
    return (await this.#firstMatching(joinCode)) !== null;
  }

  /**
   * The one statement this file runs.
   *
   * Two columns, one table, the four joinable statuses, and a limit of one.
   * Written through `sql.ts` rather than by hand so that every value is a
   * bound parameter and nothing is formatted into the text.
   */
  async #firstMatching(joinCode: string): Promise<DirectoryRow | null> {
    const params = new Params();
    const where = buildFilter(
      { join_code: joinCode, status: JOINABLE_SESSION_STATUSES },
      params,
    );

    const sql =
      `SELECT ${buildColumnList(COLUMNS)} FROM ${quoteIdentifier(TABLE)}` +
      ` WHERE ${where} LIMIT ${params.bind(1)}`;

    const result = await this.#db.query<DirectoryRow>(sql, params.values);
    return result.rows[0] ?? null;
  }
}

/** Builds the directory. */
export function joinCodeDirectory(db: Queryable): JoinCodeDirectory {
  return new JoinCodeDirectory(db);
}

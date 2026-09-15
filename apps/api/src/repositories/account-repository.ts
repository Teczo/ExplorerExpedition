/**
 * Reading and writing the tables that belong to no organisation (EXPD-004).
 *
 * Accounts, passwords, organisations and sign-ins. Every one of these reads
 * crosses the tenant boundary, because there is no tenant to be inside yet:
 * signing in starts with an email and nothing else.
 *
 * So each call goes through `GlobalRepository`, which makes it state a
 * reason. Read the reasons in this file as the complete list of places where
 * the platform looks at a row without an organisation in hand. It is short,
 * and it should stay short.
 */

import type { OrganisationId, UserId } from '@explorer/shared-types';

import type { GlobalRepository } from '../db/index.ts';
import { Params, quoteIdentifier } from '../db/index.ts';
import type { Queryable } from '../db/queryable.ts';
import type { AuthRevocationReason } from './rows.ts';
import type {
  AppUserRow,
  AuthSessionRow,
  MembershipRow,
  OrganisationRow,
  UserCredentialRow,
} from './rows.ts';

/** One organisation a person may act for, with the role they hold in it. */
export interface MembershipWithOrganisation {
  readonly membership: MembershipRow;
  readonly organisation: OrganisationRow;
}

/** What a new sign-in needs recording. */
export interface NewAuthSession {
  readonly userId: UserId;
  readonly familyId: string;
  readonly refreshTokenHash: string;
  readonly expiresAt: Date;
  readonly userAgent?: string | null;
  readonly ipAddress?: string | null;
}

/** Accounts, passwords, organisations and sign-ins. */
export class AccountRepository {
  readonly #db: Queryable;
  readonly #global: GlobalRepository;

  constructor(db: Queryable, global: GlobalRepository) {
    this.#db = db;
    this.#global = global;
  }

  /** The same repository against a different connection, such as a transaction. */
  withConnection(db: Queryable, global: GlobalRepository): AccountRepository {
    return new AccountRepository(db, global);
  }

  // --- Accounts -----------------------------------------------------------

  /**
   * Finds the account for an email address.
   *
   * Compared without case, against the same `lower(email)` expression the
   * unique index in migration 0001 is built on, so the lookup uses it.
   */
  async findUserByEmail(email: string): Promise<AppUserRow | null> {
    const params = new Params();
    const sql =
      `SELECT * FROM ${quoteIdentifier('app_user')}` +
      ` WHERE lower(email) = lower(${params.bind(email)})` +
      ' LIMIT 1';

    const result = await this.#db.query<AppUserRow>(sql, params.values);
    return result.rows[0] ?? null;
  }

  /** Finds an account by its id. */
  async findUserById(userId: UserId): Promise<AppUserRow | null> {
    return this.#global.findOne<AppUserRow>('app_user', {
      where: { id: userId },
      reason: 'auth: load the account a token names, to check it is still active',
    });
  }

  /** Records that an account was seen, so a list of staff can show it. */
  async touchUserLastSeen(userId: UserId, at: Date): Promise<void> {
    await this.#global.update<AppUserRow>(
      'app_user',
      { id: userId },
      { last_seen_at: at },
      { reason: 'auth: record that the account signed in' },
    );
  }

  // --- Passwords ----------------------------------------------------------

  /** Reads the stored password verifier for an account. */
  async findCredential(userId: UserId): Promise<UserCredentialRow | null> {
    return this.#global.findOne<UserCredentialRow>('user_credential', {
      where: { user_id: userId },
      reason: 'auth: check the password offered at sign-in',
    });
  }

  /**
   * Sets an account's password, replacing any it already had.
   *
   * It does not revoke the older sign-ins. The service does that, in the same
   * transaction, so that this stays one statement about one table.
   */
  async setPassword(userId: UserId, passwordHash: string, at: Date): Promise<void> {
    const params = new Params();
    const sql =
      'INSERT INTO "user_credential" (user_id, password_hash, password_changed_at)' +
      ` VALUES (${params.bind(userId)}, ${params.bind(passwordHash)}, ${params.bind(at)})` +
      ' ON CONFLICT (user_id) DO UPDATE SET' +
      ' password_hash = EXCLUDED.password_hash,' +
      ' password_changed_at = EXCLUDED.password_changed_at';

    await this.#db.query(sql, params.values);
  }

  // --- Organisations a person may act for ---------------------------------

  /**
   * Every organisation the person may act for, with the role they hold.
   *
   * Only active memberships of active organisations. An invite that has not
   * been accepted, a revoked membership and a suspended school all drop out
   * here rather than being filtered by whoever calls.
   */
  async listActiveMemberships(userId: UserId): Promise<MembershipWithOrganisation[]> {
    const params = new Params();
    const sql =
      'SELECT m.id AS m_id, m.organisation_id AS m_organisation_id,' +
      ' m.user_id AS m_user_id, m.role AS m_role, m.status AS m_status,' +
      ' o.id AS o_id, o.name AS o_name, o.slug AS o_slug, o.status AS o_status,' +
      ' o.timezone AS o_timezone, o.locale AS o_locale' +
      ' FROM "membership" m' +
      ' JOIN "organisation" o ON o.id = m.organisation_id' +
      ` WHERE m.user_id = ${params.bind(userId)}` +
      " AND m.status = 'active' AND o.status = 'active'" +
      ' ORDER BY o.name ASC';

    const result = await this.#db.query<Record<string, never>>(sql, params.values);
    return result.rows.map((row) => splitMembershipRow(row));
  }

  /**
   * The person's active membership of one organisation, or null.
   *
   * This is the check that makes a token org-scoped. A caller asking for an
   * access token for an organisation gets one only if this returns a row, and
   * it is run again on every refresh, so revoking a membership ends the access
   * within the life of one access token.
   */
  async findActiveMembership(
    userId: UserId,
    organisationId: OrganisationId,
  ): Promise<MembershipWithOrganisation | null> {
    const params = new Params();
    const sql =
      'SELECT m.id AS m_id, m.organisation_id AS m_organisation_id,' +
      ' m.user_id AS m_user_id, m.role AS m_role, m.status AS m_status,' +
      ' o.id AS o_id, o.name AS o_name, o.slug AS o_slug, o.status AS o_status,' +
      ' o.timezone AS o_timezone, o.locale AS o_locale' +
      ' FROM "membership" m' +
      ' JOIN "organisation" o ON o.id = m.organisation_id' +
      ` WHERE m.user_id = ${params.bind(userId)}` +
      ` AND m.organisation_id = ${params.bind(organisationId)}` +
      " AND m.status = 'active' AND o.status = 'active'" +
      ' LIMIT 1';

    const result = await this.#db.query<Record<string, never>>(sql, params.values);
    const row = result.rows[0];
    return row === undefined ? null : splitMembershipRow(row);
  }

  /** Finds an organisation by its id, whatever its status. */
  async findOrganisationById(
    organisationId: OrganisationId,
  ): Promise<OrganisationRow | null> {
    return this.#global.findOne<OrganisationRow>('organisation', {
      where: { id: organisationId },
      reason: 'auth: name the organisation a token was asked for',
    });
  }

  // --- Sign-ins -----------------------------------------------------------

  /** Records a new sign-in and returns it. */
  async createAuthSession(session: NewAuthSession): Promise<AuthSessionRow> {
    return this.#global.insert<AuthSessionRow>(
      'auth_session',
      {
        user_id: session.userId,
        family_id: session.familyId,
        refresh_token_hash: session.refreshTokenHash,
        expires_at: session.expiresAt,
        user_agent: session.userAgent ?? null,
        ip_address: session.ipAddress ?? null,
      },
      { reason: 'auth: record a sign-in so its refresh token can be withdrawn' },
    );
  }

  /** Finds a sign-in by the hash of its refresh token. */
  async findAuthSessionByTokenHash(hash: string): Promise<AuthSessionRow | null> {
    return this.#global.findOne<AuthSessionRow>('auth_session', {
      where: { refresh_token_hash: hash },
      reason: 'auth: look up the refresh token that was presented',
    });
  }

  /** Marks a sign-in as exchanged for the next token in its family. */
  async markAuthSessionRotated(sessionId: string, at: Date): Promise<void> {
    await this.#global.update<AuthSessionRow>(
      'auth_session',
      { id: sessionId },
      { rotated_at: at, last_used_at: at },
      { reason: 'auth: the refresh token was exchanged for a new one' },
    );
  }

  /**
   * Withdraws every sign-in in a family.
   *
   * Called on sign-out, and on reuse of a token that had already been
   * exchanged. Reuse means two people hold a token from the same sign-in, and
   * one of them should not, so the whole family goes rather than a guess at
   * which.
   */
  async revokeFamily(
    familyId: string,
    reason: AuthRevocationReason,
    at: Date,
  ): Promise<number> {
    const params = new Params();
    const sql =
      'UPDATE "auth_session"' +
      ` SET revoked_at = ${params.bind(at)}, revoked_reason = ${params.bind(reason)}` +
      `::auth_revocation_reason` +
      ` WHERE family_id = ${params.bind(familyId)} AND revoked_at IS NULL`;

    const result = await this.#db.query(sql, params.values);
    return result.rowCount ?? 0;
  }

  /**
   * Withdraws every sign-in an account has.
   *
   * What a password change does, so that changing it really does sign the
   * other phones out.
   */
  async revokeAllForUser(
    userId: UserId,
    reason: AuthRevocationReason,
    at: Date,
  ): Promise<number> {
    const params = new Params();
    const sql =
      'UPDATE "auth_session"' +
      ` SET revoked_at = ${params.bind(at)}, revoked_reason = ${params.bind(reason)}` +
      `::auth_revocation_reason` +
      ` WHERE user_id = ${params.bind(userId)} AND revoked_at IS NULL`;

    const result = await this.#db.query(sql, params.values);
    return result.rowCount ?? 0;
  }
}

/**
 * Splits one joined row back into the two rows it was built from.
 *
 * The join aliases every column, because `membership` and `organisation` both
 * have `id` and `status` and the driver would otherwise hand back whichever
 * came last.
 */
function splitMembershipRow(row: Record<string, unknown>): MembershipWithOrganisation {
  return {
    membership: {
      id: row['m_id'] as string,
      organisation_id: row['m_organisation_id'] as string,
      user_id: row['m_user_id'] as string,
      role: row['m_role'] as MembershipRow['role'],
      status: row['m_status'] as MembershipRow['status'],
    },
    organisation: {
      id: row['o_id'] as string,
      name: row['o_name'] as string,
      slug: row['o_slug'] as string,
      status: row['o_status'] as OrganisationRow['status'],
      timezone: row['o_timezone'] as string,
      locale: row['o_locale'] as string,
    },
  };
}

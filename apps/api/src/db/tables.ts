/**
 * Which tables belong to an organisation, and which do not (EXPD-004).
 *
 * This is the list the repository layer checks before it builds a statement.
 * If a table is tenant scoped, every statement against it carries an
 * `organisation_id` predicate; if it is not, a tenant-scoped repository
 * refuses to touch it at all and the caller has to reach for the global
 * repository and say why.
 *
 * The list is not guessed. It is the `organisation_id` column of every table
 * in `apps/api/db/migrations/`, read straight out of an applied schema. When
 * a migration adds a table, it is added here in the same change, and the
 * check in `assertTableRegistryMatchesSchema` catches it if it is not.
 */

import {
  AppendOnlyTableError,
  TenantScopeError,
  UnsafeIdentifierError,
} from './errors.ts';

/** How a table relates to the organisation that owns its rows. */
export type TableScope =
  /**
   * Every row belongs to exactly one organisation. `organisation_id` is
   * `NOT NULL`, and the predicate is `organisation_id = $org`.
   */
  | 'tenant'
  /**
   * Rows belong to one organisation, except for the ones with a NULL
   * `organisation_id`, which the platform provides and every organisation may
   * read. Reads match either; writes only ever set the caller's own id.
   */
  | 'tenant-or-shared'
  /**
   * The table belongs to no organisation. `organisation`, `app_user` and the
   * sign-in tables are here, because a person is not owned by a school: the
   * same teacher can work for two.
   */
  | 'global';

/**
 * Every table in the schema, and how it is scoped.
 *
 * Kept in alphabetical order so that comparing it against
 * `information_schema` is easy to read.
 */
export const TABLE_SCOPES = {
  app_user: 'global',
  ar_asset: 'tenant',
  /**
   * Tenant scoped even though the column is nullable. A NULL here is a
   * platform-level action, which is the opposite of a row everyone may read,
   * so `organisation_id = $org` is the right predicate and it excludes NULLs
   * on its own.
   */
  audit_log: 'tenant',
  auth_session: 'global',
  badge: 'tenant-or-shared',
  expedition: 'tenant',
  expedition_session: 'tenant',
  expedition_version: 'tenant',
  hint: 'tenant',
  inventory_item: 'tenant',
  live_event: 'tenant',
  media_asset: 'tenant',
  membership: 'tenant',
  mission_attempt: 'tenant',
  mission_instance: 'tenant',
  mission_node: 'tenant',
  mission_template: 'tenant-or-shared',
  mission_type: 'tenant-or-shared',
  organisation: 'global',
  participant: 'tenant',
  participant_device: 'tenant',
  qr_marker: 'tenant',
  score_event: 'tenant',
  submission: 'tenant',
  subscription: 'tenant',
  team: 'tenant',
  team_member: 'tenant',
  user_credential: 'global',
} as const satisfies Readonly<Record<string, TableScope>>;

/** The name of a table this schema has. */
export type TableName = keyof typeof TABLE_SCOPES;

/** The name of a table a tenant-scoped repository may touch. */
export type TenantTableName = {
  [TKey in TableName]: (typeof TABLE_SCOPES)[TKey] extends 'global' ? never : TKey;
}[TableName];

/** The name of a table only the global repository may touch. */
export type GlobalTableName = {
  [TKey in TableName]: (typeof TABLE_SCOPES)[TKey] extends 'global' ? TKey : never;
}[TableName];

/** Every table name, as a plain list. */
export const TABLE_NAMES = Object.keys(TABLE_SCOPES) as readonly TableName[];

/** Returns true when the name is a table this schema has. */
export function isTableName(value: string): value is TableName {
  return Object.hasOwn(TABLE_SCOPES, value);
}

/** Returns how the table is scoped, or throws if the name is not a table. */
export function scopeOf(table: string): TableScope {
  if (!isTableName(table)) {
    throw new TenantScopeError(
      `${JSON.stringify(table)} is not a table in this schema. ` +
        'A table added by a migration has to be added to TABLE_SCOPES too.',
    );
  }
  return TABLE_SCOPES[table];
}

/**
 * Returns the table name, having checked it can be tenant scoped.
 *
 * The repository layer calls this before it builds anything. A global table
 * reaching a tenant-scoped repository is a mistake in the calling code, and
 * the message says which of the two ways out to take.
 */
export function assertTenantScoped(table: string): TenantTableName {
  const scope = scopeOf(table);
  if (scope === 'global') {
    throw new TenantScopeError(
      `${table} has no organisation_id, so it cannot be filtered by organisation. ` +
        'Read it through GlobalRepository, which makes the caller state why the ' +
        'read is allowed to cross the tenant boundary.',
    );
  }
  return table as TenantTableName;
}

/** Returns the table name, having checked it really is a global table. */
export function assertGlobal(table: string): GlobalTableName {
  const scope = scopeOf(table);
  if (scope !== 'global') {
    throw new TenantScopeError(
      `${table} carries organisation_id, so it must be read through a ` +
        'tenant-scoped repository rather than the global one.',
    );
  }
  return table as GlobalTableName;
}

/**
 * The tables a row is only ever added to (EXPD-006).
 *
 * `audit_log` is the record of who changed what. A record that can be edited
 * answers nothing, because the first thing somebody covering their tracks
 * would edit is the line about them doing it. So the table takes an INSERT
 * and nothing else, and it is refused in two places: here, before a statement
 * is built, and by the triggers migration 0003 attaches to the table, which
 * hold for every caller rather than only for this code.
 *
 * `score_event` and `live_event` are written once too, and they are
 * deliberately not in this list yet. Holding the score stream to it is
 * EXPD-014, which owns that table; adding it here is the whole change when
 * that ticket comes round.
 */
export const APPEND_ONLY_TABLES: readonly TableName[] = ['audit_log'];

/** Returns true when rows can only ever be added to the table. */
export function isAppendOnly(table: string): boolean {
  return (APPEND_ONLY_TABLES as readonly string[]).includes(table);
}

/**
 * Returns the table name, having checked rows in it can be changed at all.
 *
 * Every `update` and `delete` in the repository layer calls this first. A
 * read is untouched: the log exists to be read.
 */
export function assertWritable<TTable extends string>(
  table: TTable,
  operation: 'UPDATE' | 'DELETE',
): TTable {
  if (isAppendOnly(table)) {
    throw new AppendOnlyTableError(table, operation);
  }
  return table;
}

/** A plain SQL identifier: lower case, starting with a letter or underscore. */
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * Quotes an identifier for use in a statement.
 *
 * Identifiers never come from a request. This check is here so that a future
 * caller that passes one through by accident fails loudly rather than
 * quietly building a statement out of somebody else's string.
 */
export function quoteIdentifier(value: string): string {
  if (!IDENTIFIER.test(value)) {
    throw new UnsafeIdentifierError(value);
  }
  return `"${value}"`;
}

/**
 * Compares this registry against a live database.
 *
 * Meant for a start-up check and for the isolation tests in EXPD-005: a table
 * that a migration added but nobody listed here would otherwise only be
 * noticed the first time somebody queried it.
 *
 * `rows` is what `information_schema` gives back for the public schema.
 */
export function findTableRegistryDrift(
  rows: readonly { table: string; organisationIdIsNullable: boolean | null }[],
): readonly string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    seen.add(row.table);

    if (!isTableName(row.table)) {
      problems.push(`${row.table} is in the database but not in TABLE_SCOPES.`);
      continue;
    }

    const scope = TABLE_SCOPES[row.table];
    const hasColumn = row.organisationIdIsNullable !== null;

    if (scope === 'global' && hasColumn) {
      problems.push(
        `${row.table} is listed as global but has an organisation_id column.`,
      );
    }
    if (scope !== 'global' && !hasColumn) {
      problems.push(
        `${row.table} is listed as ${scope} but has no organisation_id column.`,
      );
    }
    if (scope === 'tenant-or-shared' && row.organisationIdIsNullable === false) {
      problems.push(
        `${row.table} is listed as tenant-or-shared but its organisation_id is NOT NULL, ` +
          'so it has no shared rows.',
      );
    }
  }

  for (const table of TABLE_NAMES) {
    if (!seen.has(table)) {
      problems.push(`${table} is in TABLE_SCOPES but not in the database.`);
    }
  }

  return problems;
}

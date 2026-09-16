/**
 * Two organisations, and a row of every table for each (EXPD-005).
 *
 * Nearly every test here is the same experiment: put a row in for Portside
 * School and a row in for Riverbank Academy, act as one of them, and check
 * the other one's row is neither returned nor changed. This file sets that up
 * once so each test can say what it is proving rather than how it got there.
 *
 * The rows are minimal on purpose. `FakeDatabase` stores whatever it is
 * given, so a row needs only the columns a test looks at: its id, the
 * organisation that owns it, and a label that says which organisation put it
 * there. Nothing here is a claim about the real schema — that claim is made
 * in `table-registry.test.ts`, against the migrations themselves.
 */

import type { OrganisationId } from '@explorer/shared-types';

import {
  TABLE_NAMES,
  TABLE_SCOPES,
  isAppendOnly,
  type GlobalTableName,
  type TableName,
  type TenantTableName,
} from '../../src/db/tables.ts';
import { tenantRepository, type TenantRepository } from '../../src/db/tenant-repository.ts';
import { globalRepository, type GlobalRepository } from '../../src/db/global-repository.ts';
import type { Queryable } from '../../src/db/queryable.ts';
import type { FakeDatabase, FakeRow } from './fake-database.ts';

/** The organisation a test usually acts as. */
export const ORG_A = '11111111-1111-4111-8111-111111111111' as OrganisationId;

/** The organisation a test must never reach. */
export const ORG_B = '22222222-2222-4222-8222-222222222222' as OrganisationId;

/** An organisation that owns nothing at all. */
export const ORG_EMPTY = '33333333-3333-4333-8333-333333333333' as OrganisationId;

/** Every table a tenant-scoped repository is allowed to touch. */
export const TENANT_TABLES: readonly TenantTableName[] = TABLE_NAMES.filter(
  (table) => TABLE_SCOPES[table] !== 'global',
) as readonly TenantTableName[];

/**
 * Every tenant table whose rows can still be changed after they are written.
 *
 * The same list as `TENANT_TABLES` minus the append-only ones (EXPD-006). The
 * update and delete tests loop over this, because an update against
 * `audit_log` is refused before the isolation predicate is ever built, which
 * is a different claim and has its own tests in `test/audit/`.
 */
export const WRITABLE_TENANT_TABLES: readonly TenantTableName[] =
  TENANT_TABLES.filter((table) => !isAppendOnly(table));

/**
 * The tenant tables a row can only ever be added to.
 *
 * Read from the registry rather than written out, so that a table EXPD-014
 * adds to it is covered by the refusal tests without anybody remembering to
 * list it twice.
 */
export const APPEND_ONLY_TENANT_TABLES: readonly TenantTableName[] =
  TENANT_TABLES.filter((table) => isAppendOnly(table));

/** The tables that also hold platform-wide rows every organisation may read. */
export const SHARED_TABLES: readonly TenantTableName[] = TABLE_NAMES.filter(
  (table) => TABLE_SCOPES[table] === 'tenant-or-shared',
) as readonly TenantTableName[];

/** The tables that belong to no organisation. */
export const GLOBAL_TABLES: readonly GlobalTableName[] = TABLE_NAMES.filter(
  (table) => TABLE_SCOPES[table] === 'global',
) as readonly GlobalTableName[];

/** The id of the row an organisation owns in a table. */
export function rowId(table: TableName, organisation: 'a' | 'b' | 'shared'): string {
  return `${table}-${organisation}`;
}

/**
 * Puts one row per organisation in every tenant table, and a platform-wide
 * row in each table that can hold one.
 */
export function seedBothOrganisations(db: FakeDatabase): void {
  for (const table of TENANT_TABLES) {
    db.seed(
      table,
      { id: rowId(table, 'a'), organisation_id: ORG_A, owner: 'Portside School' },
      { id: rowId(table, 'b'), organisation_id: ORG_B, owner: 'Riverbank Academy' },
    );

    if (TABLE_SCOPES[table] === 'tenant-or-shared') {
      db.seed(table, {
        id: rowId(table, 'shared'),
        organisation_id: null,
        owner: 'the platform',
      });
    }
  }
}

/** Builds a repository pinned to one organisation. */
export function tenantFor(
  db: Queryable,
  organisationId: OrganisationId,
  options: { readonly includeSharedRows?: boolean } = {},
): TenantRepository {
  return tenantRepository(db, {
    organisationId,
    ...(options.includeSharedRows === undefined
      ? {}
      : { includeSharedRows: options.includeSharedRows }),
  });
}

/** Builds a repository for the tables that belong to no organisation. */
export function globalFor(db: Queryable): GlobalRepository {
  return globalRepository(db);
}

/** The `organisation_id` on a row the database handed back. */
export function organisationOf(row: FakeRow | null): unknown {
  return row === null ? null : row['organisation_id'];
}

/** The `organisation_id` on each of a set of rows. */
export function organisationsOf(rows: readonly FakeRow[]): readonly unknown[] {
  return rows.map((row) => row['organisation_id']);
}

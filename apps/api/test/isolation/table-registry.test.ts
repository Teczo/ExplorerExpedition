/**
 * The registry and the schema say the same thing (EXPD-005).
 *
 * `TABLE_SCOPES` decides, for every statement the repository layer builds,
 * whether an `organisation_id` predicate is attached. A table missing from
 * that list is a table nothing scopes, so the list being right is the
 * foundation the rest of the isolation rests on — and it is the one part that
 * cannot be checked by running a query, because a forgotten table is one
 * nobody queries yet.
 *
 * So these tests read the migrations. They parse every `CREATE TABLE` in
 * `apps/api/db/migrations/`, note whether it has an `organisation_id` column
 * and whether that column is nullable, and hand the result to
 * `findTableRegistryDrift` — the same function a start-up check would call
 * against `information_schema`. A migration that adds a table without adding
 * it here fails this test on the commit that adds it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  TABLE_NAMES,
  TABLE_SCOPES,
  assertGlobal,
  assertTenantScoped,
  findTableRegistryDrift,
  isTableName,
  quoteIdentifier,
  scopeOf,
} from '../../src/db/tables.ts';
import { TenantScopeError, UnsafeIdentifierError } from '../../src/db/errors.ts';
import { GLOBAL_TABLES, TENANT_TABLES } from '../support/organisations.ts';

/** One table as the migrations define it. */
interface SchemaTable {
  readonly table: string;
  /** Null when the table has no `organisation_id` column at all. */
  readonly organisationIdIsNullable: boolean | null;
}

const MIGRATIONS_DIRECTORY = new URL('../../db/migrations/', import.meta.url).pathname;

/** Reads every migration, oldest first. */
function readMigrations(): readonly { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIRECTORY)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(join(MIGRATIONS_DIRECTORY, name), 'utf8'),
    }));
}

/**
 * Pulls every `CREATE TABLE` out of the migrations.
 *
 * It is not a SQL parser. It does not need to be: the migrations are written
 * by hand in one house style, one column to a line, and a shape this does not
 * recognise shows up as a missing table rather than as a wrong answer,
 * because `findTableRegistryDrift` reports anything in the registry that the
 * schema does not have.
 */
function readSchemaTables(): readonly SchemaTable[] {
  const tables: SchemaTable[] = [];

  for (const migration of readMigrations()) {
    const pattern = /^CREATE TABLE (?<table>[a-z_]+) \(\n(?<body>[\s\S]*?)^\);$/gm;

    for (const match of migration.sql.matchAll(pattern)) {
      const groups = match.groups as { table: string; body: string };
      tables.push({
        table: groups.table,
        organisationIdIsNullable: readOrganisationIdColumn(groups.body),
      });
    }
  }

  return tables;
}

/** Null when there is no such column, otherwise whether it accepts NULL. */
function readOrganisationIdColumn(body: string): boolean | null {
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!/^organisation_id\s/.test(trimmed)) {
      continue;
    }
    return !/\bNOT NULL\b/.test(trimmed);
  }
  return null;
}

describe('the registry against the migrations', () => {
  const schema = readSchemaTables();

  test('the migrations parse into the number of tables the schema documents', () => {
    // 25 in 0001, three more in 0002. A change to either number is a schema
    // change, and it should be made deliberately rather than noticed later.
    assert.equal(schema.length, 28);
  });

  test('every table in the database is in TABLE_SCOPES, and the other way round', () => {
    assert.deepEqual(findTableRegistryDrift(schema), []);
  });

  test('every tenant-scoped table really has an organisation_id column', () => {
    for (const table of TENANT_TABLES) {
      const defined = schema.find((row) => row.table === table);
      assert.notEqual(defined, undefined, `${table} is in TABLE_SCOPES but not in the schema`);
      assert.notEqual(
        defined?.organisationIdIsNullable,
        null,
        `${table} is tenant scoped but has no organisation_id column`,
      );
    }
  });

  test('every global table really has no organisation_id column', () => {
    for (const table of GLOBAL_TABLES) {
      const defined = schema.find((row) => row.table === table);
      assert.equal(
        defined?.organisationIdIsNullable,
        null,
        `${table} is listed as global but the schema gives it an organisation_id`,
      );
    }
  });

  test('no migration bolts an organisation_id onto a table after the fact', () => {
    // A column added by ALTER TABLE would not be seen by the parser above, so
    // the tests would keep passing while the registry went stale.
    for (const migration of readMigrations()) {
      assert.equal(
        /ALTER TABLE[\s\S]*?ADD COLUMN\s+organisation_id/.test(migration.sql),
        false,
        `${migration.name} adds organisation_id with ALTER TABLE; the registry check cannot see that`,
      );
    }
  });
});

describe('findTableRegistryDrift', () => {
  test('reports a table the database has and the registry does not', () => {
    const problems = findTableRegistryDrift([
      ...TABLE_NAMES.map((table) => ({
        table,
        organisationIdIsNullable: TABLE_SCOPES[table] === 'global' ? null : true,
      })),
      { table: 'expedition_note', organisationIdIsNullable: false },
    ]);

    assert.deepEqual(problems, ['expedition_note is in the database but not in TABLE_SCOPES.']);
  });

  test('reports a table the registry has and the database does not', () => {
    const problems = findTableRegistryDrift(
      TABLE_NAMES.filter((table) => table !== 'team').map((table) => ({
        table,
        organisationIdIsNullable: TABLE_SCOPES[table] === 'global' ? null : true,
      })),
    );

    assert.deepEqual(problems, ['team is in TABLE_SCOPES but not in the database.']);
  });

  test('reports a tenant table that lost its organisation_id column', () => {
    const problems = findTableRegistryDrift(
      TABLE_NAMES.map((table) => ({
        table,
        organisationIdIsNullable: table === 'team' ? null : TABLE_SCOPES[table] === 'global' ? null : true,
      })),
    );

    assert.deepEqual(problems, [
      'team is listed as tenant but has no organisation_id column.',
    ]);
  });

  test('reports a global table that grew an organisation_id column', () => {
    const problems = findTableRegistryDrift(
      TABLE_NAMES.map((table) => ({
        table,
        organisationIdIsNullable: table === 'app_user' ? false : TABLE_SCOPES[table] === 'global' ? null : true,
      })),
    );

    assert.deepEqual(problems, [
      'app_user is listed as global but has an organisation_id column.',
    ]);
  });

  test('reports a shared table whose organisation_id can no longer be NULL', () => {
    const problems = findTableRegistryDrift(
      TABLE_NAMES.map((table) => ({
        table,
        organisationIdIsNullable:
          TABLE_SCOPES[table] === 'global' ? null : table !== 'mission_type',
      })),
    );

    assert.deepEqual(problems, [
      'mission_type is listed as tenant-or-shared but its organisation_id is NOT NULL, ' +
        'so it has no shared rows.',
    ]);
  });
});

describe('the guards on the way into a repository', () => {
  test('a tenant-scoped repository refuses every global table', () => {
    for (const table of GLOBAL_TABLES) {
      assert.throws(() => assertTenantScoped(table), TenantScopeError, table);
    }
  });

  test('the global repository refuses every tenant-scoped table', () => {
    for (const table of TENANT_TABLES) {
      assert.throws(() => assertGlobal(table), TenantScopeError, table);
    }
  });

  test('a name that is not a table at all is refused by both', () => {
    assert.throws(() => assertTenantScoped('expedition_note'), TenantScopeError);
    assert.throws(() => assertGlobal('expedition_note'), TenantScopeError);
    assert.throws(() => scopeOf('expedition_note'), TenantScopeError);
    assert.equal(isTableName('expedition_note'), false);
  });

  test('the error says which way out to take', () => {
    assert.throws(
      () => assertTenantScoped('app_user'),
      /GlobalRepository/,
      'a global table in a tenant repository should point at GlobalRepository',
    );
    assert.throws(
      () => assertGlobal('team'),
      /tenant-scoped repository/,
      'a tenant table in the global repository should point back at the tenant one',
    );
  });
});

describe('identifiers never come from a caller', () => {
  for (const attempt of [
    'team"; DROP TABLE team; --',
    'team WHERE true',
    'organisation_id, 1',
    'Team',
    '1team',
    '',
    'team ',
  ]) {
    test(`quoteIdentifier refuses ${JSON.stringify(attempt)}`, () => {
      assert.throws(() => quoteIdentifier(attempt), UnsafeIdentifierError);
    });
  }

  test('quoteIdentifier accepts the names the schema really uses', () => {
    for (const table of TABLE_NAMES) {
      assert.equal(quoteIdentifier(table), `"${table}"`);
    }
  });
});

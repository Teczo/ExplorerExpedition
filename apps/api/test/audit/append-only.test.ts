/**
 * The audit log is appended to and never edited (EXPD-006).
 *
 * This is the claim the whole ticket rests on, and it is made in two places,
 * so it is tested in two places.
 *
 *   **In the database.** Migration 0003 attaches triggers that refuse an
 *   UPDATE, a DELETE and a TRUNCATE. These tests read the migration and check
 *   the triggers are there, in the same spirit as `table-registry.test.ts`:
 *   the file is the source of truth, so the file is what is read.
 *
 *   **In the repository layer.** `TenantRepository` refuses the same two
 *   statements before one is built, so the mistake is a clear refusal naming
 *   the table rather than a driver error arriving later. These tests run the
 *   repository against the in-memory store and watch nothing happen.
 *
 * The second is a convenience and the first is the rule. A test that only
 * checked the second would pass against a database anybody could edit.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { AppendOnlyTableError } from '../../src/db/errors.ts';
import {
  APPEND_ONLY_TABLES,
  assertWritable,
  isAppendOnly,
} from '../../src/db/tables.ts';
import { FakeDatabase, type FakeRow } from '../support/fake-database.ts';
import {
  APPEND_ONLY_TENANT_TABLES,
  ORG_A,
  ORG_B,
  WRITABLE_TENANT_TABLES,
  rowId,
  seedBothOrganisations,
  tenantFor,
} from '../support/organisations.ts';

const MIGRATIONS_DIRECTORY = new URL('../../db/migrations/', import.meta.url).pathname;

/** Every migration, joined up. What the database would be after applying them. */
function readAllMigrations(): string {
  return readdirSync(MIGRATIONS_DIRECTORY)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => readFileSync(join(MIGRATIONS_DIRECTORY, name), 'utf8'))
    .join('\n');
}

function withAuditRows() {
  const db = new FakeDatabase();
  seedBothOrganisations(db);
  return { db, portside: tenantFor(db, ORG_A) };
}

describe('the database refuses to change an entry', () => {
  const schema = readAllMigrations();

  for (const operation of ['UPDATE', 'DELETE', 'TRUNCATE'] as const) {
    test(`a trigger stands in front of ${operation}`, () => {
      const pattern = new RegExp(
        `CREATE TRIGGER audit_log_refuse_\\w+\\s+BEFORE ${operation} ON audit_log`,
      );
      assert.match(
        schema,
        pattern,
        `no trigger in the migrations refuses ${operation} on audit_log`,
      );
    });
  }

  test('every one of those triggers runs the refusing function', () => {
    const triggers = [
      ...schema.matchAll(/CREATE TRIGGER (audit_log_refuse_\w+)([\s\S]*?);/g),
    ];

    assert.equal(triggers.length, 3, 'expected one trigger per statement refused');
    for (const trigger of triggers) {
      assert.match(
        trigger[2] as string,
        /EXECUTE FUNCTION refuse_write_to_append_only_table\(\)/,
        `${trigger[1]} does not run the refusing function`,
      );
    }
  });

  test('the truncate trigger is per statement, because there is no other kind', () => {
    // PostgreSQL has no FOR EACH ROW truncate trigger. Writing one would make
    // the migration fail to apply, which is a mistake worth catching here
    // rather than on a deployment.
    assert.match(
      readAllMigrations(),
      /BEFORE TRUNCATE ON audit_log\s+FOR EACH STATEMENT/,
    );
  });

  test('the refusal is raised with its own SQLSTATE', () => {
    assert.match(schema, /ERRCODE = 'X0006'/);
  });

  test('no foreign key is left that would write to the table behind our back', () => {
    // `ON DELETE SET NULL` is an UPDATE run by the database itself, so a
    // foreign key left on audit_log would make deleting an organisation fail
    // once the triggers are on. 0003 drops all three.
    const createTable = /CREATE TABLE audit_log \(([\s\S]*?)^\);/m.exec(schema);
    assert.notEqual(createTable, null, 'audit_log should be created by a migration');

    const referencedColumns = [
      ...(createTable?.[1] as string).matchAll(/^\s*(\w+)\s+uuid REFERENCES (\w+)/gm),
    ].map((match) => match[1] as string);

    for (const column of referencedColumns) {
      assert.match(
        schema,
        new RegExp(`ALTER TABLE audit_log DROP CONSTRAINT audit_log_${column}_fkey`),
        `audit_log.${column} still has a foreign key, which an append-only table cannot carry`,
      );
    }
  });
});

describe('the repository refuses before it builds a statement', () => {
  for (const table of APPEND_ONLY_TENANT_TABLES) {
    describe(table, () => {
      test('update is refused, and nothing reaches the database', async () => {
        const { db, portside } = withAuditRows();
        db.forgetStatements();

        await assert.rejects(
          () => portside.update(table, { id: rowId(table, 'a') }, { action: 'changed' }),
          AppendOnlyTableError,
        );
        assert.deepEqual(db.statements, [], 'no statement should have been run');
      });

      test('updateById is refused too', async () => {
        const { portside } = withAuditRows();

        await assert.rejects(
          () => portside.updateById(table, rowId(table, 'a'), { action: 'changed' }),
          AppendOnlyTableError,
        );
      });

      test('delete is refused, and the row is still there', async () => {
        const { db, portside } = withAuditRows();
        const before = db.rowsIn(table).length;

        await assert.rejects(
          () => portside.delete(table, { id: rowId(table, 'a') }),
          AppendOnlyTableError,
        );
        assert.equal(db.rowsIn(table).length, before);
      });

      test('a delete with no filter is refused as well', async () => {
        const { db, portside } = withAuditRows();

        await assert.rejects(() => portside.delete(table, {}), AppendOnlyTableError);
        assert.equal(db.rowsIn(table).length, 2, 'both organisations’ rows survive');
      });

      test('insert still works, because appending is the whole point', async () => {
        const { portside } = withAuditRows();
        const inserted = await portside.insert<FakeRow>(table, { action: 'appended' });

        assert.equal(inserted['organisation_id'], ORG_A);
      });

      test('reading is untouched: the log exists to be read', async () => {
        const { portside } = withAuditRows();
        const rows = await portside.find<FakeRow>(table);

        assert.deepEqual(
          rows.map((row) => row['organisation_id']),
          [ORG_A],
          'a read should still return this organisation’s entries and no others',
        );
      });
    });
  }

  test('the other organisation cannot edit our entries either', async () => {
    const { db, portside } = withAuditRows();
    const riverbank = tenantFor(db, ORG_B);

    await assert.rejects(
      () => riverbank.update('audit_log', { id: rowId('audit_log', 'a') }, { action: 'x' }),
      AppendOnlyTableError,
    );
    await assert.rejects(
      () => portside.delete('audit_log', { id: rowId('audit_log', 'b') }),
      AppendOnlyTableError,
    );
  });
});

describe('what the refusal says', () => {
  test('it names the table and the statement', async () => {
    const { portside } = withAuditRows();

    await assert.rejects(
      () => portside.delete('audit_log', {}),
      (error: unknown) => {
        assert.ok(error instanceof AppendOnlyTableError);
        assert.equal(error.table, 'audit_log');
        assert.equal(error.operation, 'DELETE');
        return true;
      },
    );
  });

  test('it says what to do instead', () => {
    assert.throws(
      () => assertWritable('audit_log', 'UPDATE'),
      /appending another entry/,
      'the message should point at the way a ledger is corrected',
    );
  });
});

describe('the registry of append-only tables', () => {
  test('the audit log is on it', () => {
    assert.ok(isAppendOnly('audit_log'));
  });

  test('every name on it is a table the repository layer knows', () => {
    for (const table of APPEND_ONLY_TABLES) {
      assert.equal(isAppendOnly(table), true);
    }
  });

  test('a table that can be changed passes straight through', () => {
    for (const table of WRITABLE_TENANT_TABLES) {
      assert.equal(assertWritable(table, 'UPDATE'), table);
      assert.equal(assertWritable(table, 'DELETE'), table);
    }
  });

  test('the score stream is deliberately not on it yet', () => {
    // EXPD-014 owns `score_event`. Adding it here before that ticket would
    // break the score tests it has not written yet, and claim a rule the
    // database does not keep.
    assert.equal(isAppendOnly('score_event'), false);
    assert.equal(isAppendOnly('live_event'), false);
  });
});

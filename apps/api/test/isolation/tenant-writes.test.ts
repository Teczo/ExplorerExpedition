/**
 * No write reaches another organisation's rows (EXPD-005).
 *
 * The other half. A read that leaks shows somebody data; a write that leaks
 * changes or destroys somebody else's, which is worse and quieter. So each
 * table is checked three ways: a write aimed at the other organisation's row
 * must change nothing, a write that names the other organisation must be
 * refused outright, and a write that names nothing must land in this
 * organisation rather than nowhere.
 *
 * As in the read tests, the store underneath does no filtering. Every row
 * that survives a delete survived because of the code under test.
 *
 * The tables are looped over twice rather than once, because since EXPD-006
 * not every tenant table accepts all three statements. Inserts are checked
 * against every one of them; updates and deletes against the ones whose rows
 * can be changed at all. The append-only tables are held to their own rule in
 * `test/audit/append-only.test.ts`, and `WRITABLE_TENANT_TABLES` is derived
 * from the same registry, so a table either appears in one loop or is proved
 * to refuse the statement in the other file. Neither list can quietly lose a
 * table.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CrossTenantWriteError } from '../../src/db/errors.ts';
import { FakeDatabase, type FakeRow } from '../support/fake-database.ts';
import {
  ORG_A,
  ORG_B,
  TENANT_TABLES,
  WRITABLE_TENANT_TABLES,
  organisationsOf,
  rowId,
  seedBothOrganisations,
  tenantFor,
} from '../support/organisations.ts';

function bothOrganisations() {
  const db = new FakeDatabase();
  seedBothOrganisations(db);
  return { db, portside: tenantFor(db, ORG_A) };
}

/** The row an organisation owns in a table, as the store currently holds it. */
function storedRow(db: FakeDatabase, table: string, owner: 'a' | 'b'): FakeRow {
  const row = db.rowsIn(table).find((candidate) => candidate['id'] === `${table}-${owner}`);
  assert.notEqual(row, undefined, `${table} should still hold the ${owner} row`);
  return row as FakeRow;
}

describe('inserting into a table', () => {
  // Every tenant table, the append-only ones included: adding a row to the
  // audit log is the one thing that is always allowed (EXPD-006).
  for (const table of TENANT_TABLES) {
    describe(table, () => {
      test('insert stamps this organisation on the row', async () => {
        const { portside } = bothOrganisations();
        const inserted = await portside.insert<FakeRow>(table, { owner: 'Portside School' });

        assert.equal(inserted['organisation_id'], ORG_A);
      });

      test('insert refuses a row addressed to another organisation', async () => {
        const { db, portside } = bothOrganisations();
        const before = db.rowsIn(table).length;

        await assert.rejects(
          () => portside.insert(table, { organisation_id: ORG_B, owner: 'Riverbank Academy' }),
          CrossTenantWriteError,
        );
        assert.equal(db.rowsIn(table).length, before, 'nothing should have been written');
      });

      test('insert allows this organisation to be named explicitly', async () => {
        const { portside } = bothOrganisations();
        const inserted = await portside.insert<FakeRow>(table, {
          organisation_id: ORG_A,
          owner: 'Portside School',
        });

        assert.equal(inserted['organisation_id'], ORG_A);
      });
    });
  }
});

describe('changing or removing a row', () => {
  // Only the tables whose rows can be changed at all. An update against an
  // append-only table is refused before the isolation predicate is built, and
  // `test/audit/append-only.test.ts` is what proves it.
  for (const table of WRITABLE_TENANT_TABLES) {
    describe(table, () => {
      test('update leaves the other organisation’s row alone', async () => {
        const { db, portside } = bothOrganisations();
        const changed = await portside.update(table, { id: rowId(table, 'b') }, {
          owner: 'taken over',
        });

        assert.deepEqual(changed, []);
        assert.equal(storedRow(db, table, 'b')['owner'], 'Riverbank Academy');
      });

      test('updateById returns null for the other organisation’s key', async () => {
        const { db, portside } = bothOrganisations();

        assert.equal(
          await portside.updateById(table, rowId(table, 'b'), { owner: 'taken over' }),
          null,
        );
        assert.equal(storedRow(db, table, 'b')['owner'], 'Riverbank Academy');
      });

      test('an update with no filter changes this organisation only', async () => {
        const { db, portside } = bothOrganisations();
        const changed = await portside.update<FakeRow>(table, {}, { owner: 'renamed' });

        assert.deepEqual(organisationsOf(changed), [ORG_A]);
        assert.equal(storedRow(db, table, 'b')['owner'], 'Riverbank Academy');
      });

      test('an update may not move a row to another organisation', async () => {
        const { db, portside } = bothOrganisations();

        await assert.rejects(
          () => portside.update(table, { id: rowId(table, 'a') }, { organisation_id: ORG_B }),
          CrossTenantWriteError,
        );
        assert.equal(storedRow(db, table, 'a')['organisation_id'], ORG_A);
      });

      test('delete cannot reach the other organisation’s row', async () => {
        const { db, portside } = bothOrganisations();

        assert.equal(await portside.delete(table, { id: rowId(table, 'b') }), 0);
        assert.notEqual(storedRow(db, table, 'b'), undefined);
      });

      test('a delete with no filter empties this organisation only', async () => {
        const { db, portside } = bothOrganisations();

        assert.equal(await portside.delete(table, {}), 1);
        assert.deepEqual(
          db.rowsIn(table).filter((row) => row['organisation_id'] === ORG_A),
          [],
        );
        assert.notEqual(storedRow(db, table, 'b'), undefined);
      });

      test('a delete listing both organisations’ keys only takes ours', async () => {
        const { db, portside } = bothOrganisations();

        assert.equal(
          await portside.delete(table, { id: [rowId(table, 'a'), rowId(table, 'b')] }),
          1,
        );
        assert.notEqual(storedRow(db, table, 'b'), undefined);
      });
    });
  }
});

describe('what the refusal says', () => {
  test('a cross-tenant insert names the table and both organisations', async () => {
    const { portside } = bothOrganisations();

    await assert.rejects(
      () => portside.insert('expedition', { organisation_id: ORG_B }),
      (error: unknown) => {
        assert.ok(error instanceof CrossTenantWriteError);
        assert.equal(error.table, 'expedition');
        assert.equal(error.scopedTo, ORG_A);
        assert.equal(error.attempted, ORG_B);
        return true;
      },
    );
  });

  test('a write that tries to un-own a row is refused too', async () => {
    const { portside } = bothOrganisations();

    await assert.rejects(
      () => portside.insert('mission_type', { organisation_id: null }),
      (error: unknown) => {
        assert.ok(error instanceof CrossTenantWriteError);
        assert.equal(
          error.attempted,
          'none',
          'writing a NULL organisation_id would make a platform-wide row',
        );
        return true;
      },
    );
  });

  test('an update with nothing to change is refused before it reaches the database', async () => {
    const { db, portside } = bothOrganisations();
    db.forgetStatements();

    await assert.rejects(() => portside.update('team', { id: 'x' }, {}), /nothing to change/);
    assert.deepEqual(db.statements, []);
  });
});

describe('every write binds the organisation', () => {
  test('the predicate is on the update and the delete, not only the read', async () => {
    const { db, portside } = bothOrganisations();
    db.forgetStatements();

    await portside.update('team', { id: rowId('team', 'a') }, { owner: 'renamed' });
    await portside.delete('team', { id: rowId('team', 'a') });

    for (const statement of db.statements) {
      assert.match(
        statement.text,
        /WHERE "organisation_id" = \$\d+/,
        `a write ran without the isolation predicate:\n  ${statement.text}`,
      );
      assert.ok(statement.values.includes(ORG_A));
      assert.equal(statement.text.includes(ORG_A), false);
    }
  });

  test('an insert always carries organisation_id in its column list', async () => {
    const { db, portside } = bothOrganisations();
    db.forgetStatements();

    await portside.insert('team', { owner: 'Portside School' });

    assert.match(db.lastStatement.text, /INSERT INTO "team" \([^)]*"organisation_id"[^)]*\)/);
    assert.ok(db.lastStatement.values.includes(ORG_A));
  });
});

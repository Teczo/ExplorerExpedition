/**
 * The one widening, and how far it goes (EXPD-005).
 *
 * `includeSharedRows` lets an organisation read the platform-wide mission
 * types, templates and badges — the rows with a NULL `organisation_id`. It is
 * the only sanctioned way a tenant-scoped read returns a row the organisation
 * does not own, so it is worth pinning down exactly:
 *
 *   it widens reads, and only on the three tables that have shared rows;
 *   it never widens a write, on any table;
 *   and it never, under any setting, shows another organisation's rows.
 *
 * That last one is the point. "Everyone may read the QR hunt type" must not
 * quietly become "everyone may read everything".
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CrossTenantWriteError } from '../../src/db/errors.ts';
import { TABLE_SCOPES } from '../../src/db/tables.ts';
import { Params } from '../../src/db/sql.ts';
import { FakeDatabase, type FakeRow } from '../support/fake-database.ts';
import {
  ORG_A,
  ORG_B,
  SHARED_TABLES,
  TENANT_TABLES,
  organisationsOf,
  rowId,
  seedBothOrganisations,
  tenantFor,
} from '../support/organisations.ts';

/** The tables that are scoped to one organisation and nothing else. */
const OWNED_ONLY_TABLES = TENANT_TABLES.filter(
  (table) => TABLE_SCOPES[table] === 'tenant',
);

function bothOrganisations() {
  const db = new FakeDatabase();
  seedBothOrganisations(db);
  return {
    db,
    narrow: tenantFor(db, ORG_A),
    wide: tenantFor(db, ORG_A, { includeSharedRows: true }),
  };
}

test('the three shared tables are the ones the schema gives shared rows to', () => {
  assert.deepEqual([...SHARED_TABLES], ['badge', 'mission_template', 'mission_type']);
});

describe('reading with includeSharedRows', () => {
  for (const table of SHARED_TABLES) {
    describe(table, () => {
      test('off by default: only this organisation’s rows come back', async () => {
        const { narrow } = bothOrganisations();

        assert.deepEqual(organisationsOf(await narrow.find<FakeRow>(table)), [ORG_A]);
      });

      test('on: this organisation’s rows and the platform’s, and no others', async () => {
        const { wide } = bothOrganisations();
        const rows = await wide.find<FakeRow>(table);

        assert.deepEqual([...organisationsOf(rows)].sort(), [null, ORG_A].sort());
        assert.equal(
          rows.some((row) => row['organisation_id'] === ORG_B),
          false,
          'widening to the platform must not widen to another organisation',
        );
      });

      test('the other organisation’s row stays out of reach by id', async () => {
        const { wide } = bothOrganisations();

        assert.equal(await wide.findById(table, rowId(table, 'b')), null);
        assert.notEqual(await wide.findById(table, rowId(table, 'shared')), null);
      });

      test('an update cannot touch the platform’s row', async () => {
        const { db, wide } = bothOrganisations();
        const changed = await wide.update(table, { id: rowId(table, 'shared') }, {
          owner: 'taken over',
        });

        assert.deepEqual(changed, []);
        const shared = db.rowsIn(table).find((row) => row['id'] === rowId(table, 'shared'));
        assert.equal(shared?.['owner'], 'the platform');
      });

      test('a delete cannot take the platform’s row', async () => {
        const { db, wide } = bothOrganisations();

        assert.equal(await wide.delete(table, { id: rowId(table, 'shared') }), 0);
        assert.notEqual(
          db.rowsIn(table).find((row) => row['id'] === rowId(table, 'shared')),
          undefined,
        );
      });

      test('an insert cannot create a platform-wide row', async () => {
        const { wide } = bothOrganisations();

        await assert.rejects(
          () => wide.insert(table, { organisation_id: null }),
          CrossTenantWriteError,
        );
      });

      test('a delete with no filter leaves the platform’s row standing', async () => {
        const { db, wide } = bothOrganisations();

        assert.equal(await wide.delete(table, {}), 1);
        assert.deepEqual(
          db
            .rowsIn(table)
            .map((row) => row['organisation_id'])
            .sort(),
          [null, ORG_B].sort(),
        );
      });
    });
  }
});

describe('the widening does not spread', () => {
  for (const table of OWNED_ONLY_TABLES) {
    test(`${table} ignores includeSharedRows`, async () => {
      const db = new FakeDatabase();
      seedBothOrganisations(db);
      // A row nobody owns, in a table that should have none. It must stay
      // invisible even to a repository that asked for shared rows.
      db.seed(table, { id: `${table}-orphan`, organisation_id: null, owner: 'nobody' });

      const rows = await tenantFor(db, ORG_A, { includeSharedRows: true }).find<FakeRow>(
        table,
      );

      assert.deepEqual(organisationsOf(rows), [ORG_A]);
    });
  }
});

describe('the predicates a hand-written statement is given', () => {
  test('a read predicate widens on a shared table when asked', () => {
    const wide = tenantFor(new FakeDatabase(), ORG_A, { includeSharedRows: true });
    const params = new Params();

    assert.equal(
      wide.readPredicate('mission_type', params),
      '("organisation_id" = $1 OR "organisation_id" IS NULL)',
    );
    assert.deepEqual(params.values, [ORG_A]);
  });

  test('a read predicate stays narrow on an owned table', () => {
    const wide = tenantFor(new FakeDatabase(), ORG_A, { includeSharedRows: true });

    assert.equal(wide.readPredicate('expedition', new Params()), '"organisation_id" = $1');
  });

  test('a write predicate is never widened, whatever the scope says', () => {
    const wide = tenantFor(new FakeDatabase(), ORG_A, { includeSharedRows: true });

    for (const table of SHARED_TABLES) {
      assert.equal(
        wide.writePredicate(table, new Params()),
        '"organisation_id" = $1',
        `${table} must not be writable just because it is readable`,
      );
    }
  });
});

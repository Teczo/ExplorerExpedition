/**
 * No read reaches another organisation's rows (EXPD-005).
 *
 * Half of the claim EXPD-004 makes. The database here holds one row per
 * organisation in every tenant-scoped table, and the store itself does no
 * filtering at all — if a statement asks for Riverbank Academy's row, it gets
 * it. So every row that fails to come back is the repository layer keeping it
 * back, and nothing else.
 *
 * The sweep runs over every tenant table rather than a representative few,
 * because the predicate is attached per table and a table nobody thought
 * about is exactly how a leak would arrive.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { FakeDatabase, type FakeRow } from '../support/fake-database.ts';
import {
  ORG_A,
  ORG_B,
  ORG_EMPTY,
  TENANT_TABLES,
  organisationsOf,
  rowId,
  seedBothOrganisations,
  tenantFor,
} from '../support/organisations.ts';

/** A database holding both organisations' rows, and a repository for one. */
function bothOrganisations() {
  const db = new FakeDatabase();
  seedBothOrganisations(db);
  return { db, portside: tenantFor(db, ORG_A), riverbank: tenantFor(db, ORG_B) };
}

describe('reading a table', () => {
  for (const table of TENANT_TABLES) {
    describe(table, () => {
      test('find returns only this organisation’s rows', async () => {
        const { portside } = bothOrganisations();
        const rows = await portside.find<FakeRow>(table);

        assert.deepEqual(organisationsOf(rows), [ORG_A]);
      });

      test('an empty filter does not mean every row in the table', async () => {
        const { portside } = bothOrganisations();
        const rows = await portside.find<FakeRow>(table, { where: {} });

        assert.equal(rows.length, 1);
      });

      test('findById refuses the other organisation’s primary key', async () => {
        const { portside } = bothOrganisations();

        assert.equal(await portside.findById(table, rowId(table, 'b')), null);
        assert.notEqual(await portside.findById(table, rowId(table, 'a')), null);
      });

      test('findOne cannot be steered onto the other organisation', async () => {
        const { portside } = bothOrganisations();
        const row = await portside.findOne<FakeRow>(table, {
          where: { organisation_id: ORG_B },
        });

        assert.equal(
          row,
          null,
          'a caller-supplied organisation_id must narrow the result, never widen it',
        );
      });

      test('count counts this organisation only', async () => {
        const { portside, riverbank } = bothOrganisations();

        assert.equal(await portside.count(table), 1);
        assert.equal(await riverbank.count(table), 1);
        assert.equal(await tenantFor(new FakeDatabase(), ORG_A).count(table), 0);
      });

      test('exists does not see the other organisation’s row', async () => {
        const { portside } = bothOrganisations();

        assert.equal(await portside.exists(table, { id: rowId(table, 'b') }), false);
        assert.equal(await portside.exists(table, { id: rowId(table, 'a') }), true);
      });

      test('an organisation that owns nothing reads nothing', async () => {
        const { db } = bothOrganisations();
        const stranger = tenantFor(db, ORG_EMPTY);

        assert.deepEqual(await stranger.find(table), []);
        assert.equal(await stranger.count(table), 0);
      });
    });
  }
});

describe('the ways a caller might try to widen a read', () => {
  test('an IN filter listing both organisations still returns one row', async () => {
    const { portside } = bothOrganisations();
    const rows = await portside.find<FakeRow>('expedition', {
      where: { organisation_id: [ORG_A, ORG_B] },
    });

    assert.deepEqual(organisationsOf(rows), [ORG_A]);
  });

  test('an IN filter on ids listing both organisations returns one row', async () => {
    const { portside } = bothOrganisations();
    const rows = await portside.find<FakeRow>('expedition', {
      where: { id: [rowId('expedition', 'a'), rowId('expedition', 'b')] },
    });

    assert.deepEqual(
      rows.map((row) => row['id']),
      [rowId('expedition', 'a')],
    );
  });

  test('a filter asking for a NULL organisation matches nothing', async () => {
    const { portside } = bothOrganisations();
    const rows = await portside.find('mission_type', { where: { organisation_id: null } });

    assert.deepEqual(rows, []);
  });

  test('columns cannot be used to drop the predicate', async () => {
    const { portside } = bothOrganisations();
    const rows = await portside.find<FakeRow>('team', { columns: ['id'] });

    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], { id: rowId('team', 'a') });
  });

  test('limit and offset page within the organisation, not across it', async () => {
    const db = new FakeDatabase();
    db.seed(
      'team',
      { id: 'a1', organisation_id: ORG_A, owner: 'Portside School' },
      { id: 'b1', organisation_id: ORG_B, owner: 'Riverbank Academy' },
      { id: 'a2', organisation_id: ORG_A, owner: 'Portside School' },
      { id: 'b2', organisation_id: ORG_B, owner: 'Riverbank Academy' },
    );
    const portside = tenantFor(db, ORG_A);

    const page = await portside.find<FakeRow>('team', {
      orderBy: [{ column: 'id' }],
      limit: 10,
      offset: 0,
    });

    assert.deepEqual(
      page.map((row) => row['id']),
      ['a1', 'a2'],
      'paging past the end of one organisation must not spill into the next',
    );
  });

  test('ordering does not pull another organisation’s row into view', async () => {
    const db = new FakeDatabase();
    db.seed(
      'team',
      { id: 'a1', organisation_id: ORG_A, owner: 'Portside School', name: 'Zebra' },
      { id: 'b1', organisation_id: ORG_B, owner: 'Riverbank Academy', name: 'Aardvark' },
    );

    const rows = await tenantFor(db, ORG_A).find<FakeRow>('team', {
      orderBy: [{ column: 'name', direction: 'asc' }],
      limit: 1,
    });

    assert.deepEqual(organisationsOf(rows), [ORG_A]);
  });

  test('FOR UPDATE locks only this organisation’s rows', async () => {
    const { db, portside } = bothOrganisations();
    const rows = await portside.find<FakeRow>('expedition_session', { forUpdate: true });

    assert.deepEqual(organisationsOf(rows), [ORG_A]);
    assert.match(db.lastStatement.text, /FOR UPDATE$/);
    assert.ok(
      db.lastStatement.values.includes(ORG_A),
      'the organisation has to reach the statement as a bound value',
    );
  });

  test('a repository cannot be pointed at another organisation after it is built', () => {
    const { portside } = bothOrganisations();

    assert.equal(portside.organisationId, ORG_A);
    assert.equal(
      Object.getOwnPropertyDescriptor(portside, 'organisationId'),
      undefined,
      'organisationId is a getter over a private field, so there is nothing to assign to',
    );
  });

  test('withConnection keeps the organisation it was built with', async () => {
    const { db, portside } = bothOrganisations();
    const other = new FakeDatabase();
    seedBothOrganisations(other);

    const moved = portside.withConnection(other);
    assert.equal(moved.organisationId, ORG_A);
    assert.deepEqual(organisationsOf(await moved.find<FakeRow>('team')), [ORG_A]);
    assert.equal(db.statements.length, 0, 'the statement should have run on the new connection');
  });
});

describe('every statement binds the organisation rather than writing it in', () => {
  test('the organisation never appears in the SQL text', async () => {
    const { db, portside } = bothOrganisations();

    await portside.find('team');
    await portside.count('team');
    await portside.exists('team', { id: 'x' });
    await portside.findById('team', 'x');

    assert.notEqual(db.statements.length, 0);
    for (const statement of db.statements) {
      assert.equal(
        statement.text.includes(ORG_A),
        false,
        `the organisation was formatted into the statement:\n  ${statement.text}`,
      );
      assert.ok(
        statement.values.includes(ORG_A),
        `the organisation was not bound to the statement:\n  ${statement.text}`,
      );
      assert.match(statement.text, /WHERE "organisation_id" = \$1/);
    }
  });
});

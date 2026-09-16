/**
 * The escape hatch does not let anything out (EXPD-005).
 *
 * `find` cannot express a join, so `TenantRepository` offers three things for
 * a statement written by hand: `readPredicate`, `writePredicate` and
 * `queryScoped`. They are the most dangerous surface in the repository layer,
 * because this is the one place a developer types SQL, so they get their own
 * tests.
 *
 * Note the last test in this file. `queryScoped` checks that a statement
 * mentions `organisation_id`; it does not parse it, and it cannot tell a
 * predicate in the right place from one in the wrong place. That limit is
 * written down in the code, and it is written down here as well, so that
 * nobody reads these tests as a promise the code does not make.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CrossTenantWriteError, TenantScopeError } from '../../src/db/errors.ts';
import { Params } from '../../src/db/sql.ts';
import { FakeDatabase, type FakeRow } from '../support/fake-database.ts';
import { RecordingDatabase } from '../support/recording-database.ts';
import {
  GLOBAL_TABLES,
  ORG_A,
  ORG_B,
  organisationsOf,
  seedBothOrganisations,
  tenantFor,
} from '../support/organisations.ts';

describe('the predicate a hand-written statement asks for', () => {
  test('is a bound placeholder, never the organisation written into the text', () => {
    const params = new Params();
    const predicate = tenantFor(new FakeDatabase(), ORG_A).readPredicate('team', params);

    assert.equal(predicate, '"organisation_id" = $1');
    assert.deepEqual(params.values, [ORG_A]);
  });

  test('takes a table alias, for a statement that joins', () => {
    const params = new Params();
    const predicate = tenantFor(new FakeDatabase(), ORG_A).readPredicate(
      'team',
      params,
      't',
    );

    assert.equal(predicate, '"t"."organisation_id" = $1');
  });

  test('numbers its placeholder after whatever the caller has already bound', () => {
    const params = new Params();
    params.bind('playing');
    const predicate = tenantFor(new FakeDatabase(), ORG_A).writePredicate('team', params);

    assert.equal(predicate, '"organisation_id" = $2');
    assert.deepEqual(params.values, ['playing', ORG_A]);
  });

  test('is refused for a table that has no organisation_id', () => {
    const portside = tenantFor(new FakeDatabase(), ORG_A);

    for (const table of GLOBAL_TABLES) {
      assert.throws(() => portside.readPredicate(table, new Params()), TenantScopeError);
      assert.throws(() => portside.writePredicate(table, new Params()), TenantScopeError);
    }
  });

  test('is refused for a name that is not a table', () => {
    const portside = tenantFor(new FakeDatabase(), ORG_A);

    assert.throws(() => portside.readPredicate('expedition_note', new Params()), TenantScopeError);
    assert.throws(() => portside.writePredicate('expedition_note', new Params()), TenantScopeError);
  });
});

describe('a statement written by hand, run through queryScoped', () => {
  test('returns only this organisation’s rows', async () => {
    const db = new FakeDatabase();
    seedBothOrganisations(db);
    const portside = tenantFor(db, ORG_A);

    const params = new Params();
    const scoped = portside.readPredicate('team', params);
    const rows = await portside.queryScoped<FakeRow>(
      `SELECT * FROM "team" WHERE ${scoped} AND "owner" = ${params.bind('Portside School')}`,
      params,
    );

    assert.deepEqual(organisationsOf(rows), [ORG_A]);
  });

  test('cannot be pointed at the other organisation by binding its id', async () => {
    const db = new FakeDatabase();
    seedBothOrganisations(db);
    const portside = tenantFor(db, ORG_A);

    const params = new Params();
    const scoped = portside.readPredicate('team', params);
    const rows = await portside.queryScoped<FakeRow>(
      `SELECT * FROM "team" WHERE ${scoped} AND "organisation_id" = ${params.bind(ORG_B)}`,
      params,
    );

    assert.deepEqual(rows, [], 'the two predicates should contradict each other');
  });

  test('is refused when it does not mention the tenant column at all', async () => {
    const portside = tenantFor(new FakeDatabase(), ORG_A);
    const params = new Params();

    await assert.rejects(
      () => portside.queryScoped('SELECT * FROM "team" WHERE true', params),
      CrossTenantWriteError,
    );
  });

  test('the refusal never reaches the database', async () => {
    const db = new FakeDatabase();
    const portside = tenantFor(db, ORG_A);

    await assert.rejects(
      () => portside.queryScoped('SELECT * FROM "team"', new Params()),
      CrossTenantWriteError,
    );
    assert.deepEqual(db.statements, []);
  });

  test('a join keeps the predicate on the tenant-scoped side', async () => {
    const db = new RecordingDatabase().answer('JOIN', [
      { id: 'team-a', organisation_id: ORG_A },
    ]);
    const portside = tenantFor(db, ORG_A);

    const params = new Params();
    const scoped = portside.readPredicate('team', params, 't');
    const rows = await portside.queryScoped<FakeRow>(
      'SELECT t.* FROM "team" t' +
        ' JOIN "participant" p ON p.team_id = t.id' +
        ` WHERE ${scoped}`,
      params,
    );

    assert.deepEqual(organisationsOf(rows), [ORG_A]);
    const statement = db.statementContaining('JOIN');
    assert.match(statement.text, /WHERE "t"\."organisation_id" = \$1/);
    assert.deepEqual(statement.values, [ORG_A]);
  });
});

describe('what queryScoped does not promise', () => {
  test('it is a guard rail, not a parser', async () => {
    // The check is `sql.includes('organisation_id')`. A statement that names
    // the column somewhere harmless passes it. This test exists so the limit
    // is recorded rather than assumed away: the protection for a hand-written
    // statement is `readPredicate`, and `queryScoped` only catches the case
    // of forgetting it entirely.
    const db = new FakeDatabase();
    seedBothOrganisations(db);
    const portside = tenantFor(db, ORG_A);

    const rows = await portside.queryScoped<FakeRow>(
      'SELECT "id", "organisation_id" FROM "team" WHERE true',
      new Params(),
    );

    assert.equal(rows.length, 2, 'a statement that only mentions the column is let through');
  });
});

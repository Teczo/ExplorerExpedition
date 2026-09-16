/**
 * The four tables that belong to nobody, and the wall around them (EXPD-005).
 *
 * `organisation`, `app_user`, `user_credential` and `auth_session` have no
 * `organisation_id`, so nothing can scope a statement against them. That is
 * correct — a teacher who works for two schools is one person, not two — and
 * it is also the one place in the codebase where a query runs with no tenant
 * predicate at all.
 *
 * Which makes the size of the hole the thing to test. The hole is four
 * tables. These tests check that it is exactly four: that no tenant-scoped
 * table can be reached through this repository, by any of its four
 * operations, and that no name outside the schema can be either.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { TenantScopeError } from '../../src/db/errors.ts';
import { FakeDatabase, type FakeRow } from '../support/fake-database.ts';
import { GLOBAL_TABLES, TENANT_TABLES, globalFor } from '../support/organisations.ts';

const REASON = { reason: 'test: check the boundary around the global tables' };

test('there are four global tables, and these are they', () => {
  assert.deepEqual(
    [...GLOBAL_TABLES],
    ['app_user', 'auth_session', 'organisation', 'user_credential'],
  );
});

describe('a tenant-scoped table cannot be reached through the global repository', () => {
  for (const table of TENANT_TABLES) {
    test(table, async () => {
      const db = new FakeDatabase();
      const global = globalFor(db);

      await assert.rejects(
        () => global.find(table as never, REASON),
        TenantScopeError,
        `find should refuse ${table}`,
      );
      await assert.rejects(
        () => global.findOne(table as never, REASON),
        TenantScopeError,
        `findOne should refuse ${table}`,
      );
      await assert.rejects(
        () => global.insert(table as never, { id: 'x' }, REASON),
        TenantScopeError,
        `insert should refuse ${table}`,
      );
      await assert.rejects(
        () => global.update(table as never, { id: 'x' }, { owner: 'y' }, REASON),
        TenantScopeError,
        `update should refuse ${table}`,
      );
      await assert.rejects(
        () => global.delete(table as never, { id: 'x' }, REASON),
        TenantScopeError,
        `delete should refuse ${table}`,
      );

      assert.deepEqual(db.statements, [], 'nothing should have reached the database');
    });
  }
});

describe('a name that is not a table at all', () => {
  test('is refused', async () => {
    const global = globalFor(new FakeDatabase());

    await assert.rejects(() => global.find('expedition_note' as never, REASON), TenantScopeError);
    await assert.rejects(
      () => global.insert('expedition_note' as never, {}, REASON),
      TenantScopeError,
    );
  });
});

describe('the four tables it does reach', () => {
  for (const table of GLOBAL_TABLES) {
    test(`${table} can be read, written and deleted`, async () => {
      const db = new FakeDatabase();
      db.seed(table, { id: 'existing', label: 'before' });
      const global = globalFor(db);

      const found = await global.find<FakeRow>(table, { where: { id: 'existing' }, ...REASON });
      assert.equal(found.length, 1);

      const inserted = await global.insert<FakeRow>(table, { id: 'fresh' }, REASON);
      assert.equal(inserted['id'], 'fresh');

      const changed = await global.update<FakeRow>(
        table,
        { id: 'existing' },
        { label: 'after' },
        REASON,
      );
      assert.equal(changed.length, 1);

      assert.equal(await global.delete(table, { id: 'fresh' }, REASON), 1);
    });

    test(`${table} is queried without a tenant predicate, and that is deliberate`, async () => {
      const db = new FakeDatabase();
      db.seed(table, { id: 'existing' });
      await globalFor(db).find(table, { where: { id: 'existing' }, ...REASON });

      assert.equal(
        db.lastStatement.text.includes('organisation_id'),
        false,
        `${table} has no organisation_id, so a predicate on it would not compile`,
      );
    });
  }
});

describe('an update with nothing to change', () => {
  test('is refused before it reaches the database', async () => {
    const db = new FakeDatabase();

    await assert.rejects(
      () => globalFor(db).update('app_user', { id: 'x' }, {}, REASON),
      /nothing to change/,
    );
    assert.deepEqual(db.statements, []);
  });
});

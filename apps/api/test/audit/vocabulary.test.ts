/**
 * The vocabulary means what it says (EXPD-006).
 *
 * `@explorer/shared-types` lists what an entry can say happened, and what
 * kind of row each action is about. That list is a promise to two different
 * readers: to the database, that `entity_type` holds a real table name, and
 * to whoever reads the log later, that `action` is a word they have seen
 * before.
 *
 * Neither promise can be kept by the type system. `AUDIT_ENTITY_TYPES` is
 * written out by hand, because a package may not import from an app, so
 * nothing stops it naming a table the schema does not have. These tests are
 * what stops it: they compare the shared list against the table registry that
 * `table-registry.test.ts` in turn compares against the migrations.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMINISTRATIVE_AUDIT_ACTIONS,
  AUDIT_ACTIONS,
  AUDIT_ACTOR_KINDS,
  AUDIT_ENTITY_TYPES,
  AUDIT_ENTITY_TYPE_BY_ACTION,
  PERMISSIONS_BY_ROLE,
  ROLES,
  SCORING_AUDIT_ACTIONS,
  entityTypeOf,
  isAuditAction,
  isAuditActorKind,
  isScoringAuditAction,
} from '@explorer/shared-types';

import { isTableName } from '../../src/db/tables.ts';

describe('every entity type is a table the schema has', () => {
  for (const entityType of AUDIT_ENTITY_TYPES) {
    test(entityType, () => {
      assert.equal(
        isTableName(entityType),
        true,
        `${entityType} is in AUDIT_ENTITY_TYPES but is not a table in TABLE_SCOPES`,
      );
    });
  }

  test('an entry could be joined back to the row it names', () => {
    // `entity_id` has no foreign key, on purpose: an entry about something
    // deleted is exactly the entry somebody will want. So the join is done by
    // hand, and it only works if the table name is real.
    for (const action of AUDIT_ACTIONS) {
      assert.equal(isTableName(entityTypeOf(action)), true, action);
    }
  });
});

describe('every action is about something', () => {
  test('the map covers every action and nothing else', () => {
    assert.deepEqual(
      Object.keys(AUDIT_ENTITY_TYPE_BY_ACTION).sort(),
      [...AUDIT_ACTIONS].sort(),
    );
  });

  test('every entity type it names is on the list of entity types', () => {
    for (const action of AUDIT_ACTIONS) {
      assert.ok(
        (AUDIT_ENTITY_TYPES as readonly string[]).includes(entityTypeOf(action)),
        `${action} is about ${entityTypeOf(action)}, which is not an audit entity type`,
      );
    }
  });

  test('no entity type is listed and then never used', () => {
    const used = new Set(AUDIT_ACTIONS.map((action) => entityTypeOf(action)));

    for (const entityType of AUDIT_ENTITY_TYPES) {
      assert.ok(used.has(entityType), `nothing is ever recorded about ${entityType}`);
    }
  });
});

describe('the two halves of the log', () => {
  test('the scope asked for scoring changes, and there are some', () => {
    assert.ok(SCORING_AUDIT_ACTIONS.length > 0);
  });

  test('it asked for administrative actions too, and there are some', () => {
    assert.ok(ADMINISTRATIVE_AUDIT_ACTIONS.length > 0);
  });

  test('the two lists do not overlap', () => {
    const administrative = new Set<string>(ADMINISTRATIVE_AUDIT_ACTIONS);

    for (const action of SCORING_AUDIT_ACTIONS) {
      assert.equal(administrative.has(action), false, `${action} is in both lists`);
    }
  });

  test('together they are the whole list, and in that order', () => {
    assert.deepEqual(
      [...AUDIT_ACTIONS],
      [...SCORING_AUDIT_ACTIONS, ...ADMINISTRATIVE_AUDIT_ACTIONS],
    );
  });

  test('a scoring action is recognised as one, and an admin action is not', () => {
    assert.equal(isScoringAuditAction('score.adjusted'), true);
    assert.equal(isScoringAuditAction('member.revoked'), false);
  });

  test('a hand adjustment by a teacher has a name', () => {
    // EXPD-058 lets a teacher change a score by hand. That is the single
    // most important thing in the log for anybody asking why a team won.
    assert.ok((AUDIT_ACTIONS as readonly string[]).includes('score.adjusted'));
  });
});

describe('the names themselves', () => {
  test('each is `thing.what-happened`, in lower case', () => {
    for (const action of AUDIT_ACTIONS) {
      assert.match(action, /^[a-z][a-z-]*\.[a-z][a-z-]*$/, action);
    }
  });

  test('none is listed twice', () => {
    assert.equal(new Set(AUDIT_ACTIONS).size, AUDIT_ACTIONS.length);
    assert.equal(new Set(AUDIT_ENTITY_TYPES).size, AUDIT_ENTITY_TYPES.length);
  });

  test('a word nobody has agreed on is not an action', () => {
    assert.equal(isAuditAction('expedition.tweaked'), false);
    assert.equal(isAuditAction(''), false);
    assert.equal(isAuditAction(42), false);
    assert.equal(isAuditAction('expedition.published'), true);
  });
});

describe('the actor kinds match the enum in the schema', () => {
  test('there are four, in the order 0001 declares them', () => {
    assert.deepEqual([...AUDIT_ACTOR_KINDS], ['user', 'participant', 'system', 'service']);
  });

  test('anything else is refused', () => {
    assert.equal(isAuditActorKind('robot'), false);
    assert.equal(isAuditActorKind(undefined), false);
    assert.equal(isAuditActorKind('participant'), true);
  });
});

describe('who may read the log', () => {
  test('`audit:read` exists, because EXPD-004 promised it to this ticket', () => {
    assert.ok(PERMISSIONS_BY_ROLE['org-admin'].includes('audit:read'));
  });

  test('a creator and a facilitator cannot read it', () => {
    // The log records what people did to each other's work. Running a class
    // is not a reason to read it.
    assert.equal(PERMISSIONS_BY_ROLE['creator'].includes('audit:read'), false);
    assert.equal(PERMISSIONS_BY_ROLE['facilitator'].includes('audit:read'), false);
  });

  test('a student’s phone certainly cannot', () => {
    assert.equal(PERMISSIONS_BY_ROLE['student-device'].includes('audit:read'), false);
  });

  test('no role holds a permission to change the log, because there is none', () => {
    for (const role of ROLES) {
      for (const permission of PERMISSIONS_BY_ROLE[role]) {
        assert.equal(
          /^audit:(write|delete|update)$/.test(permission),
          false,
          `${role} holds ${permission}, but nothing may change an entry`,
        );
      }
    }
  });
});

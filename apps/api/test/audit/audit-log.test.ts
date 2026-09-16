/**
 * Appending to the log, and reading it back (EXPD-006).
 *
 * `AuditLog` is built on a `TenantRepository`, so the isolation it inherits
 * is already proved by EXPD-005 and is not re-proved here. What is proved
 * here is what the class itself decides: which columns an entry carries, how
 * the actor is named, where the entity type comes from, and that reading is
 * ordered and bounded.
 *
 * Two of these tests are about something that is not there. There is no
 * method that edits an entry and no method that removes one, and that is not
 * an omission to be fixed later — it is the ticket.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { toId, type ParticipantId, type UserId } from '@explorer/shared-types';

import {
  AuditLog,
  DEFAULT_AUDIT_PAGE,
  MAX_AUDIT_PAGE,
  actorLabel,
  auditLog,
  toAuditEntry,
} from '../../src/audit/audit-log.ts';
import { serviceActor, systemActor } from '../../src/audit/context.ts';
import { REDACTED } from '../../src/audit/redact.ts';
import { inTransaction } from '../../src/db/queryable.ts';
import type { AuditLogRow } from '../../src/repositories/rows.ts';
import { FakeDatabase, type FakeRow } from '../support/fake-database.ts';
import { ORG_A, ORG_B, tenantFor } from '../support/organisations.ts';

const HEAD = toId<'user'>('44444444-4444-4444-8444-444444444444') as UserId;
const STUDENT = toId<'participant'>('55555555-5555-4555-8555-555555555555') as ParticipantId;

/** A log for Portside School, written by the head teacher. */
function portsideLog(db: FakeDatabase, requestId = 'req-1'): AuditLog {
  return auditLog(tenantFor(db, ORG_A), {
    actor: { kind: 'user', userId: HEAD, label: 'Head of Portside' },
    ipAddress: '203.0.113.7',
    userAgent: 'Studio/1.0',
    requestId,
  });
}

/** The row the log last wrote. */
function lastEntry(db: FakeDatabase): FakeRow {
  const rows = db.rowsIn('audit_log');
  const last = rows.at(-1);
  assert.notEqual(last, undefined, 'an entry should have been written');
  return last as FakeRow;
}

describe('one entry', () => {
  test('carries the organisation the log is pinned to', async () => {
    const db = new FakeDatabase();
    await portsideLog(db).record('expedition.published', { entityId: 'version-1' });

    assert.equal(lastEntry(db)['organisation_id'], ORG_A);
  });

  test('names who did it, and how they were known at the time', async () => {
    const db = new FakeDatabase();
    await portsideLog(db).record('expedition.published', { entityId: 'version-1' });

    const entry = lastEntry(db);
    assert.equal(entry['actor_kind'], 'user');
    assert.equal(entry['actor_user_id'], HEAD);
    assert.equal(entry['actor_participant_id'], null);
    assert.equal(entry['actor_label'], 'Head of Portside');
  });

  test('takes its entity type from the action, not from the caller', async () => {
    const db = new FakeDatabase();
    const log = portsideLog(db);

    await log.record('expedition.published', { entityId: 'version-1' });
    assert.equal(lastEntry(db)['entity_type'], 'expedition_version');

    await log.record('member.revoked', { entityId: 'membership-1' });
    assert.equal(lastEntry(db)['entity_type'], 'membership');

    await log.record('score.adjusted', { entityId: 'score-1' });
    assert.equal(lastEntry(db)['entity_type'], 'score_event');
  });

  test('records where the request came from', async () => {
    const db = new FakeDatabase();
    await portsideLog(db, 'req-42').record('session.started', { entityId: 'run-1' });

    const entry = lastEntry(db);
    assert.equal(entry['ip_address'], '203.0.113.7');
    assert.equal(entry['user_agent'], 'Studio/1.0');
    assert.equal(entry['request_id'], 'req-42');
  });

  test('leaves the time to the database unless it is told otherwise', async () => {
    const db = new FakeDatabase();
    await portsideLog(db).record('session.started', { entityId: 'run-1' });

    // No `occurred_at` in the column list, so the column default wins and the
    // time on the entry is the database's clock rather than an instance's.
    assert.equal(
      db.lastStatement.text.includes('"occurred_at"'),
      false,
      'the entry should not carry a time the API made up',
    );
  });

  test('accepts a time for an action that already happened', async () => {
    const db = new FakeDatabase();
    const when = new Date('2026-09-16T08:00:00.000Z');

    await portsideLog(db).record('score.recalculated', {
      entityId: 'team-1',
      occurredAt: when,
    });

    assert.equal((lastEntry(db)['occurred_at'] as Date).getTime(), when.getTime());
  });

  test('has an entity id of null when the action is about no single row', async () => {
    const db = new FakeDatabase();
    await portsideLog(db).record('organisation.updated');

    assert.equal(lastEntry(db)['entity_id'], null);
  });

  test('carries what changed, already redacted', async () => {
    const db = new FakeDatabase();
    await portsideLog(db).record('auth.password-changed', {
      entityId: HEAD,
      before: { password_hash: 'scrypt$old' },
      after: { password_hash: 'scrypt$new' },
    });

    const changes = lastEntry(db)['changes'] as Record<string, unknown>;
    assert.deepEqual(changes['after'], { password_hash: REDACTED });
    assert.equal(JSON.stringify(changes).includes('scrypt$new'), false);
  });

  test('is written with an INSERT and nothing else', async () => {
    const db = new FakeDatabase();
    await portsideLog(db).record('session.ended', { entityId: 'run-1' });

    for (const statement of db.statements) {
      assert.match(statement.text, /^INSERT INTO "audit_log"/);
    }
  });
});

describe('who the actor can be', () => {
  test('a staff account falls back to its id when no label was given', () => {
    assert.equal(actorLabel({ kind: 'user', userId: HEAD }), `user ${HEAD}`);
  });

  test('a student is named by id, whatever anybody passes', () => {
    // A participant is a child. Their name does not go into a record that can
    // never be edited (EXPD-071), and the type gives no way to offer one.
    assert.equal(
      actorLabel({ kind: 'participant', participantId: STUDENT }),
      `participant ${STUDENT}`,
    );
  });

  test('a student entry fills the participant column and not the user one', async () => {
    const db = new FakeDatabase();
    const log = auditLog(tenantFor(db, ORG_A), {
      actor: { kind: 'participant', participantId: STUDENT },
    });

    await log.record('participant.team-changed', { entityId: STUDENT });

    const entry = lastEntry(db);
    assert.equal(entry['actor_kind'], 'participant');
    assert.equal(entry['actor_participant_id'], STUDENT);
    assert.equal(entry['actor_user_id'], null);
  });

  test('the platform acting on its own carries neither id', async () => {
    const db = new FakeDatabase();
    const log = auditLog(tenantFor(db, ORG_A), { actor: systemActor('scoring-engine') });

    await log.record('score.awarded', { entityId: 'score-1' });

    const entry = lastEntry(db);
    assert.equal(entry['actor_kind'], 'system');
    assert.equal(entry['actor_user_id'], null);
    assert.equal(entry['actor_participant_id'], null);
    assert.equal(entry['actor_label'], 'scoring-engine');
  });

  test('an outside service is named the same way', async () => {
    const db = new FakeDatabase();
    const log = auditLog(tenantFor(db, ORG_A), { actor: serviceActor('stripe') });

    await log.record('subscription.changed', { entityId: 'sub-1' });
    assert.equal(lastEntry(db)['actor_label'], 'stripe');
  });

  test('the actor can be swapped without the organisation moving', async () => {
    const db = new FakeDatabase();
    const log = portsideLog(db).as(systemActor('scoring-engine'));

    await log.record('score.awarded', { entityId: 'score-1' });

    assert.equal(lastEntry(db)['organisation_id'], ORG_A);
    assert.equal(lastEntry(db)['actor_kind'], 'system');
  });
});

describe('reading the log back', () => {
  function seedEntries(db: FakeDatabase): void {
    db.seed(
      'audit_log',
      {
        id: 'entry-1',
        sequence: 1,
        organisation_id: ORG_A,
        action: 'expedition.published',
        entity_type: 'expedition_version',
        entity_id: 'version-1',
        actor_user_id: HEAD,
        request_id: 'req-1',
      },
      {
        id: 'entry-2',
        sequence: 2,
        organisation_id: ORG_A,
        action: 'session.started',
        entity_type: 'expedition_session',
        entity_id: 'run-1',
        actor_user_id: HEAD,
        request_id: 'req-2',
      },
      {
        id: 'entry-3',
        sequence: 3,
        organisation_id: ORG_B,
        action: 'expedition.published',
        entity_type: 'expedition_version',
        entity_id: 'version-1',
        actor_user_id: HEAD,
        request_id: 'req-1',
      },
    );
  }

  test('another organisation’s entries are not returned', async () => {
    const db = new FakeDatabase();
    seedEntries(db);

    const rows = await portsideLog(db).find();

    assert.deepEqual(
      rows.map((row) => (row as unknown as FakeRow)['id']),
      ['entry-2', 'entry-1'],
      'the Riverbank entry shares an entity id and must still not appear',
    );
  });

  test('newest first, by the database’s own counter', async () => {
    const db = new FakeDatabase();
    seedEntries(db);
    db.forgetStatements();

    await portsideLog(db).find();

    assert.match(db.lastStatement.text, /ORDER BY "sequence" DESC/);
  });

  test('a read is bounded even when nobody asks for a limit', async () => {
    const db = new FakeDatabase();
    db.forgetStatements();

    await portsideLog(db).find();

    assert.ok(db.lastStatement.values.includes(DEFAULT_AUDIT_PAGE));
  });

  test('a limit larger than the ceiling is brought back down to it', async () => {
    const db = new FakeDatabase();
    db.forgetStatements();

    await portsideLog(db).find({ limit: 10_000 });

    assert.ok(db.lastStatement.values.includes(MAX_AUDIT_PAGE));
    assert.equal(db.lastStatement.values.includes(10_000), false);
  });

  test('a history of one row is everything done to it', async () => {
    const db = new FakeDatabase();
    seedEntries(db);

    const rows = await portsideLog(db).findForEntity('expedition_version', 'version-1');

    assert.deepEqual(
      rows.map((row) => (row as unknown as FakeRow)['id']),
      ['entry-1'],
    );
  });

  test('one request reads as one story, in the order it happened', async () => {
    const db = new FakeDatabase();
    db.seed(
      'audit_log',
      { id: 'a', sequence: 1, organisation_id: ORG_A, request_id: 'req-9' },
      { id: 'b', sequence: 2, organisation_id: ORG_A, request_id: 'req-9' },
      { id: 'c', sequence: 3, organisation_id: ORG_A, request_id: 'req-other' },
    );

    const rows = await portsideLog(db).findForRequest('req-9');

    assert.deepEqual(
      rows.map((row) => (row as unknown as FakeRow)['id']),
      ['a', 'b'],
      'a request is read oldest first, because it is a story',
    );
  });

  test('several actions can be asked for at once', async () => {
    const db = new FakeDatabase();
    seedEntries(db);

    const rows = await portsideLog(db).find({
      action: ['expedition.published', 'session.started'],
    });

    assert.equal(rows.length, 2);
  });
});

describe('an entry and the change it describes land together', () => {
  test('the log can be moved onto a transaction', async () => {
    const db = new FakeDatabase();
    const tenant = tenantFor(db, ORG_A);
    const log = portsideLog(db);

    await inTransaction(db, async (tx) => {
      await tenant.withConnection(tx).insert('expedition', { title: 'Harbour Hunt' });
      await log.withConnection(tx).record('expedition.created', { entityId: 'e1' });
    });

    const shape = db.statements.map((statement) => statement.text.split(' ')[0]);
    assert.deepEqual(shape, ['BEGIN', 'INSERT', 'INSERT', 'COMMIT']);
  });

  test('a change that rolls back takes its entry with it', async () => {
    const db = new FakeDatabase();
    const log = portsideLog(db);

    await assert.rejects(
      () =>
        inTransaction(db, async (tx) => {
          await log.withConnection(tx).record('expedition.deleted', { entityId: 'e1' });
          throw new Error('the delete failed');
        }),
      /the delete failed/,
    );

    assert.equal(db.statements.at(-1)?.text, 'ROLLBACK');
  });

  test('the organisation survives the move onto the transaction', async () => {
    const db = new FakeDatabase();
    const log = portsideLog(db);

    await inTransaction(db, async (tx) => {
      await log.withConnection(tx).record('session.ended', { entityId: 'run-1' });
    });

    assert.equal(lastEntry(db)['organisation_id'], ORG_A);
  });
});

describe('a stored row, as an app reads it', () => {
  const row: AuditLogRow = {
    id: 'entry-1',
    sequence: '17',
    organisation_id: ORG_A,
    actor_kind: 'user',
    actor_user_id: HEAD,
    actor_participant_id: null,
    actor_label: 'Head of Portside',
    action: 'expedition.published',
    entity_type: 'expedition_version',
    entity_id: 'version-1',
    changes: { after: { status: 'published' } },
    ip_address: '203.0.113.7',
    user_agent: 'Studio/1.0',
    request_id: 'req-1',
    occurred_at: new Date('2026-09-16T09:00:00.000Z'),
  };

  test('the counter becomes a number a reader can sort on', () => {
    // `pg` hands a bigint back as a string, because not every bigint fits in
    // a number. This is the one place it is converted.
    assert.equal(toAuditEntry(row).sequence, 17);
  });

  test('the actor columns become one actor again', () => {
    assert.deepEqual(toAuditEntry(row).actor, {
      kind: 'user',
      userId: HEAD,
      label: 'Head of Portside',
    });
  });

  test('a student entry becomes a participant actor', () => {
    const entry = toAuditEntry({
      ...row,
      actor_kind: 'participant',
      actor_user_id: null,
      actor_participant_id: STUDENT,
      actor_label: `participant ${STUDENT}`,
    });

    assert.deepEqual(entry.actor, { kind: 'participant', participantId: STUDENT });
  });

  test('a system entry keeps its label and has no id', () => {
    const entry = toAuditEntry({
      ...row,
      actor_kind: 'system',
      actor_user_id: null,
      actor_label: 'scoring-engine',
    });

    assert.deepEqual(entry.actor, { kind: 'system', label: 'scoring-engine' });
  });

  test('everything else comes across unchanged', () => {
    const entry = toAuditEntry(row);

    assert.equal(entry.action, 'expedition.published');
    assert.equal(entry.entityType, 'expedition_version');
    assert.equal(entry.entityId, 'version-1');
    assert.equal(entry.requestId, 'req-1');
    assert.equal(entry.occurredAt.toISOString(), '2026-09-16T09:00:00.000Z');
  });
});

describe('there is no way to unsay something', () => {
  test('the class offers nothing that changes or removes an entry', () => {
    const names = [
      ...Object.getOwnPropertyNames(AuditLog.prototype),
      ...Object.keys(AuditLog.prototype),
    ];

    for (const forbidden of ['update', 'delete', 'remove', 'edit', 'amend', 'purge']) {
      assert.equal(
        names.includes(forbidden),
        false,
        `AuditLog should not offer ${forbidden}: the table takes an INSERT and nothing else`,
      );
    }
  });
});

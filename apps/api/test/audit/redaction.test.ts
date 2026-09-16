/**
 * What an entry may carry, and what it must not (EXPD-006).
 *
 * `audit_log.changes` was left with a note on it in 0001: EXPD-006 decides
 * how much of a row goes in, and what has to be left out. `src/audit/redact.ts`
 * is that decision and this is the check on it.
 *
 * The reason the check matters more here than elsewhere is that the table is
 * append-only. A password hash written into an entry by mistake cannot be
 * edited out afterwards — there is no UPDATE — so the only place to catch it
 * is before the INSERT. Every test below is a thing that must never reach the
 * column.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_RECORDED_LENGTH,
  NOT_RECORDED,
  REDACTED,
  changedColumns,
  describeChange,
  isPersonalColumn,
  isSecretColumn,
  recordable,
} from '../../src/audit/redact.ts';

describe('only the columns that moved', () => {
  test('a column with the same value on both sides is left out', () => {
    const changes = describeChange('expedition', {
      before: { title: 'Harbour Hunt', status: 'draft' },
      after: { title: 'Harbour Hunt', status: 'published' },
    });

    assert.deepEqual(changes.before, { status: 'draft' });
    assert.deepEqual(changes.after, { status: 'published' });
  });

  test('a creation has an after and no before', () => {
    const changes = describeChange('expedition', { after: { title: 'Harbour Hunt' } });

    assert.equal(changes.before, undefined);
    assert.deepEqual(changes.after, { title: 'Harbour Hunt' });
  });

  test('a deletion has a before and no after', () => {
    const changes = describeChange('expedition', { before: { title: 'Harbour Hunt' } });

    assert.deepEqual(changes.before, { title: 'Harbour Hunt' });
    assert.equal(changes.after, undefined);
  });

  test('an action that changed no column produces an empty object', () => {
    // The `audit_log_changes_is_object` constraint wants an object, and an
    // entry about starting a run has nothing to put in it.
    const changes = describeChange('expedition_session', {
      before: { status: 'scheduled' },
      after: { status: 'scheduled' },
    });

    assert.deepEqual(changes, {});
  });

  test('a column that appears on one side only counts as changed', () => {
    assert.deepEqual(changedColumns({ a: 1 }, undefined), ['a']);
    assert.deepEqual(changedColumns(undefined, { b: 2 }), ['b']);
  });

  test('two equal documents are not a change', () => {
    // The driver hands back a fresh object each time, so comparing by
    // reference would call every JSONB column changed on every write.
    assert.deepEqual(changedColumns({ config: { codes: [1] } }, { config: { codes: [1] } }), []);
  });

  test('two different documents are', () => {
    assert.deepEqual(changedColumns({ config: { codes: [1] } }, { config: { codes: [2] } }), [
      'config',
    ]);
  });

  test('a null becoming a value is a change, and the other way round', () => {
    assert.deepEqual(changedColumns({ ended_at: null }, { ended_at: 'now' }), ['ended_at']);
    assert.deepEqual(changedColumns({ ended_at: null }, { ended_at: null }), []);
  });
});

describe('a secret never reaches the column', () => {
  for (const column of [
    'password_hash',
    'password_changed_at',
    'refresh_token_hash',
    'device_token_hash',
    'api_key',
    'private_key',
    'client_secret',
    'PASSWORD_HASH',
  ]) {
    test(`${column} is recognised as a secret`, () => {
      assert.equal(isSecretColumn(column), true);
    });
  }

  test('an ordinary column is not', () => {
    for (const column of ['status', 'title', 'points', 'role', 'occurred_at']) {
      assert.equal(isSecretColumn(column), false, column);
    }
  });

  test('the value is replaced, and the column name is kept', () => {
    const changes = describeChange('app_user', {
      before: { password_hash: 'scrypt$1$old', status: 'active' },
      after: { password_hash: 'scrypt$1$new', status: 'active' },
    });

    // The entry still says the password changed. It does not say to what, or
    // from what.
    assert.deepEqual(changes.before, { password_hash: REDACTED });
    assert.deepEqual(changes.after, { password_hash: REDACTED });
  });

  test('the real value is nowhere in the document', () => {
    const changes = describeChange('app_user', {
      after: { refresh_token_hash: 'a1b2c3-the-actual-hash' },
    });

    assert.equal(JSON.stringify(changes).includes('a1b2c3'), false);
  });
});

describe('a child’s details never reach it either', () => {
  test('a participant’s name is withheld (EXPD-071)', () => {
    const changes = describeChange('participant', {
      before: { display_name: 'Ana', status: 'joined' },
      after: { display_name: 'Ana B', status: 'removed' },
    });

    assert.deepEqual(changes.before, { display_name: REDACTED, status: 'joined' });
    assert.deepEqual(changes.after, { display_name: REDACTED, status: 'removed' });
  });

  test('what a student sent in is withheld', () => {
    const changes = describeChange('submission', {
      before: { payload: { answer: 'the third door' }, status: 'pending' },
      after: { payload: { answer: 'the third door' }, status: 'accepted' },
    });

    // The payload did not change, so it is not even mentioned; the status did.
    assert.deepEqual(changes.after, { status: 'accepted' });
  });

  test('a submission payload that did change is named but not copied', () => {
    const changes = describeChange('submission', {
      before: { payload: { answer: 'first' } },
      after: { payload: { answer: 'second' } },
    });

    assert.deepEqual(changes.after, { payload: REDACTED });
    assert.equal(JSON.stringify(changes).includes('second'), false);
  });

  test('the same column on a staff row is recorded as usual', () => {
    // A teacher's own display name is not a child's, and an entry saying who
    // renamed the organisation should say what they renamed it to.
    assert.equal(isPersonalColumn('organisation', 'display_name'), false);

    const changes = describeChange('organisation', {
      before: { name: 'Portside' },
      after: { name: 'Portside School' },
    });
    assert.deepEqual(changes.after, { name: 'Portside School' });
  });

  test('the rule is about the row, not about the column name alone', () => {
    assert.equal(isPersonalColumn('participant', 'display_name'), true);
    assert.equal(isPersonalColumn('app_user', 'display_name'), false);
  });
});

describe('an entry stays a line, not an archive', () => {
  test('a document becomes a marker rather than a copy', () => {
    assert.equal(recordable({ missions: [1, 2, 3] }), NOT_RECORDED);
    assert.equal(recordable([1, 2, 3]), NOT_RECORDED);
  });

  test('a long string is cut short and marked', () => {
    const long = 'x'.repeat(MAX_RECORDED_LENGTH + 50);
    const kept = recordable(long) as string;

    assert.equal(kept.length, MAX_RECORDED_LENGTH + 1);
    assert.ok(kept.endsWith('…'));
  });

  test('a string that fits is kept exactly', () => {
    assert.equal(recordable('published'), 'published');
  });

  test('a time is recorded as an ISO string', () => {
    assert.equal(
      recordable(new Date('2026-09-16T09:30:00.000Z')),
      '2026-09-16T09:30:00.000Z',
    );
  });

  test('scalars are kept as they are', () => {
    assert.equal(recordable(42), 42);
    assert.equal(recordable(true), true);
    assert.equal(recordable(null), null);
    assert.equal(recordable(undefined), null);
  });

  test('a number JSON cannot spell becomes a marker', () => {
    assert.equal(recordable(Number.NaN), NOT_RECORDED);
    assert.equal(recordable(Number.POSITIVE_INFINITY), NOT_RECORDED);
  });

  test('a long note is cut short too', () => {
    const changes = describeChange('score_event', {
      after: { points: -10 },
      note: 'y'.repeat(MAX_RECORDED_LENGTH + 10),
    });

    assert.equal((changes.note as string).length, MAX_RECORDED_LENGTH + 1);
  });

  test('a teacher’s reason is kept, because it is the point of the entry', () => {
    const changes = describeChange('score_event', {
      after: { points: 25 },
      note: 'Team found the marker before the rain.',
    });

    assert.equal(changes.note, 'Team found the marker before the rain.');
    assert.deepEqual(changes.after, { points: 25 });
  });
});

describe('the whole document is something JSONB will take', () => {
  test('it survives a round trip through JSON', () => {
    const changes = describeChange('participant', {
      before: { display_name: 'Ana', team_id: null, joined_at: new Date(0) },
      after: { display_name: 'Ana B', team_id: 'team-1', joined_at: new Date(1000) },
      note: 'moved to even the teams up',
    });

    assert.deepEqual(JSON.parse(JSON.stringify(changes)), changes);
  });

  test('it is an object, which is what the constraint in 0001 requires', () => {
    const changes = describeChange('team', {});

    assert.equal(typeof changes, 'object');
    assert.deepEqual(changes, {});
  });
});

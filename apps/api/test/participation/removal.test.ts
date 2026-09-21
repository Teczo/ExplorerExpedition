/**
 * Taking a student out of a run (EXPD-018).
 *
 * The one write in this ticket that has to do three things at once, and the
 * reason it does them in one transaction: a student who has been taken out of
 * a lesson and whose phone goes on working is not out of the lesson.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  anonymous,
  as,
  createTeam,
  harness,
  join,
  MISSING_ID,
  ORG_A,
  participantIdOf,
  RUN_A,
  token,
  type Harness,
} from './support.ts';

/** Takes a student out of the run, as a teacher. */
async function remove(
  harnessed: Harness,
  participantId: string,
  bearer = token(ORG_A),
): Promise<{ status: number; body: Record<string, unknown> }> {
  return harnessed.request(
    `/sessions/${RUN_A}/participants/${participantId}`,
    as(bearer, { method: 'DELETE' }),
  );
}

describe('removing a student', () => {
  test('answers with them, out of the run and off their team', async () => {
    const harnessed = await harness();
    try {
      const student = participantIdOf(await join(harnessed));
      const team = String((await createTeam(harnessed, 'Red')).body['id']);
      await harnessed.request(
        `/sessions/${RUN_A}/participants/${student}/team`,
        as(token(ORG_A), { method: 'PUT', body: { teamId: team } }),
      );

      const answer = await remove(harnessed, student);

      assert.equal(answer.status, 200);
      assert.equal(answer.body['status'], 'removed');
      assert.equal(answer.body['teamId'], null);
    } finally {
      await harnessed.close();
    }
  });

  test('keeps the row, because a removed student is part of what happened', async () => {
    const harnessed = await harness();
    try {
      const student = participantIdOf(await join(harnessed));
      await remove(harnessed, student);

      const rows = harnessed.db.rowsIn('participant');

      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.['status'], 'removed');
      assert.notEqual(rows[0]?.['left_at'] ?? null, null);
    } finally {
      await harnessed.close();
    }
  });

  test('ends their team membership without deleting it', async () => {
    const harnessed = await harness();
    try {
      const student = participantIdOf(await join(harnessed));
      const team = String((await createTeam(harnessed, 'Red')).body['id']);
      await harnessed.request(
        `/sessions/${RUN_A}/participants/${student}/team`,
        as(token(ORG_A), { method: 'PUT', body: { teamId: team } }),
      );

      await remove(harnessed, student);
      const rows = harnessed.db.rowsIn('team_member');

      assert.equal(rows.length, 1);
      assert.notEqual(rows[0]?.['left_at'] ?? null, null);
      assert.equal(rows[0]?.['is_leader'], false);
    } finally {
      await harnessed.close();
    }
  });

  test('stops their phone working', async () => {
    const harnessed = await harness();
    try {
      const joined = await join(harnessed);
      const student = participantIdOf(joined);

      const before = await harnessed.request(
        '/auth/device/token',
        anonymous({
          organisationId: ORG_A,
          deviceToken: joined.body['deviceToken'],
        }),
      );
      assert.equal(before.status, 200);

      await remove(harnessed, student);

      const after = await harnessed.request(
        '/auth/device/token',
        anonymous({
          organisationId: ORG_A,
          deviceToken: joined.body['deviceToken'],
        }),
      );
      assert.equal(after.status, 401);
    } finally {
      await harnessed.close();
    }
  });

  test('takes them off the count of who is in the run', async () => {
    const harnessed = await harness();
    try {
      await join(harnessed, { deviceId: 'phone-1' });
      const second = participantIdOf(await join(harnessed, { deviceId: 'phone-2' }));
      await remove(harnessed, second);

      const answer = await harnessed.request(
        `/sessions/${RUN_A}/participants`,
        as(token(ORG_A)),
      );

      assert.equal((answer.body['participants'] as unknown[]).length, 2);
      assert.equal(answer.body['presentCount'], 1);
    } finally {
      await harnessed.close();
    }
  });

  test('is 409 the second time', async () => {
    const harnessed = await harness();
    try {
      const student = participantIdOf(await join(harnessed));
      assert.equal((await remove(harnessed, student)).status, 200);

      assert.equal((await remove(harnessed, student)).status, 409);
    } finally {
      await harnessed.close();
    }
  });

  test('is 404 for somebody who is not in this run', async () => {
    const harnessed = await harness();
    try {
      assert.equal((await remove(harnessed, MISSING_ID)).status, 404);
    } finally {
      await harnessed.close();
    }
  });

  test('is not something somebody with no role may do', async () => {
    const harnessed = await harness();
    try {
      const student = participantIdOf(await join(harnessed));

      const answer = await remove(harnessed, student, token(ORG_A, { role: 'org-member' }));

      assert.equal(answer.status, 403);
      assert.equal(harnessed.db.rowsIn('participant')[0]?.['status'], 'joined');
    } finally {
      await harnessed.close();
    }
  });
});

describe('the record of who was removed', () => {
  test('names the teacher, the student and how many phones were cut off', async () => {
    const harnessed = await harness();
    try {
      const student = participantIdOf(await join(harnessed));
      await remove(harnessed, student);

      const entries = harnessed.db
        .rowsIn('audit_log')
        .filter((row) => row['action'] === 'participant.removed');

      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.['entity_type'], 'participant');
      assert.equal(entries[0]?.['entity_id'], student);
      assert.equal(entries[0]?.['actor_kind'], 'user');

      const after = (entries[0]?.['changes'] as Record<string, unknown>)[
        'after'
      ] as Record<string, unknown>;
      assert.equal(after['status'], 'removed');
      assert.equal(after['devices_revoked'], 1);
    } finally {
      await harnessed.close();
    }
  });

  test('is not written when the removal was refused', async () => {
    const harnessed = await harness();
    try {
      await remove(harnessed, MISSING_ID);

      assert.deepEqual(
        harnessed.db
          .rowsIn('audit_log')
          .filter((row) => row['action'] === 'participant.removed'),
        [],
      );
    } finally {
      await harnessed.close();
    }
  });
});

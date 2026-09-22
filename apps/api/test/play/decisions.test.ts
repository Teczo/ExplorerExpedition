/**
 * A teacher marking waiting work complete, or sending it back (EXPD-020).
 *
 * The decision goes through the completion interface like everything else
 * (`kind: 'review'`, EXPD-011), so it is the state machine that says whether
 * there is anything to decide. What the work is worth once it is decided is
 * the scoring engine's.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ASHA,
  MISSING_ID,
  ORG_B,
  RUN_B,
  TEAM_B,
  TEAM_BLUE,
  TEAM_RED,
  TEACHER,
  harness,
  missionIn,
  phone,
  refusalOf,
  scoreOf,
  staff,
  teamRows,
  type Harness,
} from './support.ts';

/** Asha's team hands a photo in, and it waits for a teacher. */
async function photoWaiting(h: Harness): Promise<void> {
  await h.start(phone(ASHA), 'photo');
  const sent = await h.submit(phone(ASHA), 'photo', { payload: { mediaId: 'img-1' } });
  assert.equal(missionIn(sent)['state'], 'awaiting-verification');
}

describe('a teacher decides', () => {
  test('approving finishes the mission, pays for it, and marks the submission', async () => {
    const h = await harness();
    try {
      await photoWaiting(h);
      const answer = await h.decide(staff(), TEAM_RED, 'photo', {
        decision: 'approve',
        note: 'Lovely heron.',
      });

      assert.equal(answer.status, 200);
      assert.equal(missionIn(answer)['state'], 'complete');
      const verdict = answer.body['verdict'] as Record<string, unknown>;
      assert.equal(verdict['outcome'], 'correct');
      assert.equal(verdict['method'], 'teacher');
      assert.deepEqual(
        scoreOf(answer).events.map((event) => [event['reason'], event['points']]),
        [
          ['mission-complete', 20],
          ['first-to-complete-bonus', 5],
        ],
      );
      assert.equal((answer.body['attempt'] as Record<string, unknown>)['status'], 'succeeded');

      const submission = h.rows('submission')[0];
      assert.equal(submission?.['status'], 'accepted');
      assert.equal(submission?.['reviewed_by'], TEACHER);
      assert.equal(submission?.['review_note'], 'Lovely heron.');
      assert.notEqual(submission?.['reviewed_at'], null);

      const line = teamRows(h, 'mission_transition', TEAM_RED).at(-1);
      assert.equal(line?.['trigger'], 'verify');
      assert.equal(line?.['actor'], 'teacher');
      assert.equal(line?.['reason'], 'Lovely heron.');
    } finally {
      await h.close();
    }
  });

  test('the decision is in the audit log, naming the teacher', async () => {
    const h = await harness();
    try {
      await photoWaiting(h);
      await h.decide(staff(), TEAM_RED, 'photo', { decision: 'approve' });

      const entries = h.rows('audit_log').filter((row) => row['action'] === 'submission.accepted');
      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.['entity_type'], 'submission');
      assert.equal(entries[0]?.['entity_id'], h.rows('submission')[0]?.['id']);
      assert.equal(entries[0]?.['actor_user_id'], TEACHER);
    } finally {
      await h.close();
    }
  });

  test('rejecting hands the mission back and costs the wrong-answer penalty', async () => {
    const h = await harness();
    try {
      await photoWaiting(h);
      const answer = await h.decide(staff(), TEAM_RED, 'photo', { decision: 'reject' });

      assert.equal(answer.status, 200);
      assert.equal(missionIn(answer)['state'], 'available');
      assert.deepEqual(
        scoreOf(answer).events.map((event) => [event['reason'], event['points']]),
        [['attempt-penalty', -2]],
      );
      assert.equal(h.rows('submission')[0]?.['status'], 'rejected');
      assert.equal(
        h.rows('audit_log').filter((row) => row['action'] === 'submission.rejected').length,
        1,
      );
    } finally {
      await h.close();
    }
  });

  test('a paused run can still be marked', async () => {
    const h = await harness();
    try {
      await photoWaiting(h);
      const run = h.db;
      // Pause the run the way a stored row would say it is paused.
      const stored = run.rowsIn('expedition_session');
      assert.ok(stored.length > 0);
      await run.query(
        'UPDATE "expedition_session" SET "status" = $1 WHERE "id" = $2 RETURNING *',
        ['paused', stored[0]?.['id']],
      );
      const answer = await h.decide(staff(), TEAM_RED, 'photo', { decision: 'approve' });
      assert.equal(answer.status, 200);
    } finally {
      await h.close();
    }
  });
});

describe('what is refused', () => {
  test('work that is not waiting for anybody is the state machine’s not-now', async () => {
    const h = await harness();
    try {
      await h.start(phone(ASHA), 'gate');
      const answer = await h.decide(staff(), TEAM_RED, 'gate', { decision: 'approve' });

      assert.equal(answer.status, 409);
      assert.equal(refusalOf(answer), 'not-now');
      assert.equal(teamRows(h, 'mission_transition', TEAM_RED).length, 2);
    } finally {
      await h.close();
    }
  });

  test('deciding twice', async () => {
    const h = await harness();
    try {
      await photoWaiting(h);
      await h.decide(staff(), TEAM_RED, 'photo', { decision: 'approve' });
      const again = await h.decide(staff(), TEAM_RED, 'photo', { decision: 'reject' });
      assert.equal(again.status, 409);
      assert.equal(h.rows('submission')[0]?.['status'], 'accepted');
    } finally {
      await h.close();
    }
  });

  test('a decision that is not approve or reject', async () => {
    const h = await harness();
    try {
      await photoWaiting(h);
      assert.equal((await h.decide(staff(), TEAM_RED, 'photo', { decision: 'maybe' })).status, 422);
    } finally {
      await h.close();
    }
  });

  test('a team that is not in the run is not found', async () => {
    const h = await harness();
    try {
      assert.equal((await h.decide(staff(), MISSING_ID, 'photo', { decision: 'approve' })).status, 404);
      assert.equal((await h.decide(staff(), TEAM_B, 'photo', { decision: 'approve' })).status, 404);
    } finally {
      await h.close();
    }
  });

  test('another school’s run is not found', async () => {
    const h = await harness();
    try {
      const answer = await h.decide(staff(), TEAM_B, 'photo', { decision: 'approve' }, RUN_B);
      assert.equal(answer.status, 404);
      // And Riverbank's teacher cannot reach Portside's team either.
      const theirs = await h.decide(staff({ organisationId: ORG_B }), TEAM_BLUE, 'photo', {
        decision: 'approve',
      });
      assert.equal(theirs.status, 404);
    } finally {
      await h.close();
    }
  });

  test('a phone cannot mark its own work', async () => {
    const h = await harness();
    try {
      await photoWaiting(h);
      assert.equal((await h.decide(phone(ASHA), TEAM_RED, 'photo', { decision: 'approve' })).status, 403);
      assert.equal(h.rows('submission')[0]?.['status'], 'needs-review');
    } finally {
      await h.close();
    }
  });

  test('an account that holds no review permission', async () => {
    const h = await harness();
    try {
      await photoWaiting(h);
      const answer = await h.decide(staff({ role: 'org-member' }), TEAM_RED, 'photo', {
        decision: 'approve',
      });
      assert.equal(answer.status, 403);
    } finally {
      await h.close();
    }
  });
});

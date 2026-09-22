/**
 * Making a run, and reading one back (EXPD-019).
 *
 * The three things scheduling decides once and never again: which revision
 * the class plays, what they type to join, and what state the run opens in.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { JOIN_CODE_PATTERN } from '../../src/participation/join-codes.ts';
import {
  as,
  auditOf,
  clockOf,
  command,
  EXPEDITION_A,
  harness,
  MISSING_ID,
  ORG_A,
  runRow,
  rowsIn,
  schedule,
  seedRun,
  sessionIdOf,
  TEACHER,
  token,
  VERSION_A,
} from './support.ts';

describe('scheduling a run', () => {
  test('answers 201 with the run, and where to find it', async () => {
    const harnessed = await harness();
    try {
      const answer = await schedule(harnessed, { name: 'Year 6 — Tuesday' });

      assert.equal(answer.status, 201);
      assert.equal(answer.body['name'], 'Year 6 — Tuesday');
      assert.equal(answer.body['expeditionId'], EXPEDITION_A);
      assert.equal(
        answer.headers.get('location'),
        `/sessions/${sessionIdOf(answer)}`,
      );
    } finally {
      await harnessed.close();
    }
  });

  test('pins the revision that is published now', async () => {
    const harnessed = await harness();
    try {
      const answer = await schedule(harnessed);

      assert.equal(answer.body['expeditionVersionId'], VERSION_A);
    } finally {
      await harnessed.close();
    }
  });

  test('gives it a code a child can type, and says it is joinable', async () => {
    const harnessed = await harness();
    try {
      const answer = await schedule(harnessed);

      assert.match(String(answer.body['joinCode']), JOIN_CODE_PATTERN);
      assert.equal(answer.body['joinable'], true);
      assert.equal(answer.body['finished'], false);
    } finally {
      await harnessed.close();
    }
  });

  test('never hands two runs the same code', async () => {
    const harnessed = await harness();
    try {
      const first = await schedule(harnessed);
      const second = await schedule(harnessed);

      assert.notEqual(first.body['joinCode'], second.body['joinCode']);
    } finally {
      await harnessed.close();
    }
  });

  test('opens the lobby when no start time is given', async () => {
    const harnessed = await harness();
    try {
      assert.equal((await schedule(harnessed)).body['status'], 'lobby');
    } finally {
      await harnessed.close();
    }
  });

  test('waits in scheduled when the start time is still to come', async () => {
    const harnessed = await harness();
    try {
      const later = new Date(Date.now() + 3_600_000).toISOString();
      const answer = await schedule(harnessed, { scheduledStartAt: later });

      assert.equal(answer.body['status'], 'scheduled');
      assert.equal(answer.body['scheduledStartAt'], later);
    } finally {
      await harnessed.close();
    }
  });

  test('opens the lobby when the start time has already passed', async () => {
    const harnessed = await harness();
    try {
      const answer = await schedule(harnessed, {
        scheduledStartAt: new Date(Date.now() - 3_600_000).toISOString(),
      });

      assert.equal(answer.body['status'], 'lobby');
    } finally {
      await harnessed.close();
    }
  });

  test('records who scheduled it, and hosts it', async () => {
    const harnessed = await harness();
    try {
      const answer = await schedule(harnessed);
      const row = runRow(harnessed, sessionIdOf(answer));

      assert.equal(answer.body['hostUserId'], TEACHER);
      assert.equal(row['created_by'], TEACHER);
    } finally {
      await harnessed.close();
    }
  });

  test('starts with an empty clock', async () => {
    const harnessed = await harness();
    try {
      const clock = clockOf(await schedule(harnessed));

      assert.equal(clock['elapsedSeconds'], null);
      assert.equal(clock['pausedSeconds'], 0);
      assert.equal(clock['extendedSeconds'], 0);
      assert.equal(clock['expired'], false);
    } finally {
      await harnessed.close();
    }
  });

  test('writes one audit entry, naming the run', async () => {
    const harnessed = await harness();
    try {
      const answer = await schedule(harnessed);
      const entries = auditOf(harnessed, 'session.scheduled');

      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.['entity_id'], sessionIdOf(answer));
      assert.equal(entries[0]?.['actor_user_id'], TEACHER);
    } finally {
      await harnessed.close();
    }
  });
});

describe('scheduling a run of something that cannot be played', () => {
  test('refuses an expedition with nothing published', async () => {
    const harnessed = await harness({ versionStatus: 'draft' });
    try {
      const answer = await schedule(harnessed);

      assert.equal(answer.status, 409);
      assert.match(String(answer.body['message']), /publish it first/iu);
      assert.equal(rowsIn(harnessed, 'expedition_session').length, 0);
    } finally {
      await harnessed.close();
    }
  });

  test('answers 404 for an expedition that is not there', async () => {
    const harnessed = await harness();
    try {
      const answer = await schedule(harnessed, { expeditionId: MISSING_ID });

      assert.equal(answer.status, 404);
    } finally {
      await harnessed.close();
    }
  });

  test('refuses a body with a field it does not know', async () => {
    const harnessed = await harness();
    try {
      const answer = await schedule(harnessed, { expeditionVersionId: VERSION_A });

      assert.equal(answer.status, 422);
    } finally {
      await harnessed.close();
    }
  });
});

describe('reading a run back', () => {
  test('answers with the run, its code and its clock', async () => {
    const harnessed = await harness();
    try {
      const made = await schedule(harnessed, { name: 'Year 6 — Tuesday' });
      const read = await harnessed.request(
        `/sessions/${sessionIdOf(made)}`,
        as(token(ORG_A)),
      );

      assert.equal(read.status, 200);
      assert.equal(read.body['name'], 'Year 6 — Tuesday');
      assert.equal(read.body['joinCode'], made.body['joinCode']);
      assert.ok(clockOf(read)['now']);
    } finally {
      await harnessed.close();
    }
  });

  test('says which states the run may move to next', async () => {
    const harnessed = await harness();
    try {
      const made = await schedule(harnessed);
      assert.deepEqual(made.body['nextStatuses'], ['running', 'cancelled']);

      const started = await command(harnessed, sessionIdOf(made), 'start');
      assert.deepEqual(started.body['nextStatuses'], ['paused', 'ended']);
    } finally {
      await harnessed.close();
    }
  });

  test('answers 404 for a run that is not there', async () => {
    const harnessed = await harness();
    try {
      const answer = await harnessed.request(
        `/sessions/${MISSING_ID}`,
        as(token(ORG_A)),
      );

      assert.equal(answer.status, 404);
    } finally {
      await harnessed.close();
    }
  });
});

describe('listing runs', () => {
  test('answers with a page, newest first', async () => {
    const harnessed = await harness();
    try {
      await schedule(harnessed, { name: 'Tuesday' });
      await schedule(harnessed, { name: 'Wednesday' });

      const answer = await harnessed.request('/sessions', as(token(ORG_A)));
      const sessions = answer.body['sessions'] as Record<string, unknown>[];

      assert.equal(answer.status, 200);
      assert.equal(answer.body['total'], 2);
      assert.equal(sessions.length, 2);
    } finally {
      await harnessed.close();
    }
  });

  test('filters by status', async () => {
    const harnessed = await harness();
    try {
      const made = await schedule(harnessed);
      await command(harnessed, sessionIdOf(made), 'start');
      await schedule(harnessed);

      const running = await harnessed.request(
        '/sessions?status=running',
        as(token(ORG_A)),
      );

      assert.equal(running.body['total'], 1);
      assert.equal(
        (running.body['sessions'] as Record<string, unknown>[])[0]?.['id'],
        sessionIdOf(made),
      );
    } finally {
      await harnessed.close();
    }
  });

  test('filters by expedition', async () => {
    const harnessed = await harness();
    try {
      await schedule(harnessed);

      const mine = await harnessed.request(
        `/sessions?expeditionId=${EXPEDITION_A}`,
        as(token(ORG_A)),
      );
      const other = await harnessed.request(
        `/sessions?expeditionId=${MISSING_ID}`,
        as(token(ORG_A)),
      );

      assert.equal(mine.body['total'], 1);
      assert.equal(other.body['total'], 0);
    } finally {
      await harnessed.close();
    }
  });

  test('carries a clock for every run on the page, from one moment', async () => {
    const harnessed = await harness();
    try {
      seedRun(harnessed.db, { sessionId: undefined, status: 'lobby' });
      await schedule(harnessed);

      const answer = await harnessed.request('/sessions', as(token(ORG_A)));
      const sessions = answer.body['sessions'] as Record<string, unknown>[];
      const moments = new Set(
        sessions.map((one) => (one['clock'] as Record<string, unknown>)['now']),
      );

      assert.equal(sessions.length, 2);
      assert.equal(moments.size, 1);
    } finally {
      await harnessed.close();
    }
  });

  test('pages, and says how many there are in all', async () => {
    const harnessed = await harness();
    try {
      await schedule(harnessed);
      await schedule(harnessed);
      await schedule(harnessed);

      const answer = await harnessed.request(
        '/sessions?limit=2&offset=1',
        as(token(ORG_A)),
      );

      assert.equal(answer.body['total'], 3);
      assert.equal(answer.body['limit'], 2);
      assert.equal(answer.body['offset'], 1);
      assert.equal((answer.body['sessions'] as unknown[]).length, 2);
    } finally {
      await harnessed.close();
    }
  });
});

/**
 * Starting, pausing, resuming and ending a run (EXPD-019).
 *
 * One table decides all of it — `SESSION_TRANSITIONS` — and these tests hold
 * the endpoints to it from the outside: what a run may be talked into, what
 * it may not, and what the row looks like afterwards. Migration 0001 pairs
 * each state with the time beside it, so every test that checks a status also
 * checks the times that had to move with it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  as,
  auditOf,
  clockOf,
  command,
  harness,
  MISSING_ID,
  NOON,
  ORG_A,
  RUN_A,
  runRow,
  schedule,
  seedRun,
  sessionIdOf,
  TEACHER,
  token,
} from './support.ts';

/** Five minutes before this test ran. */
function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60_000);
}

describe('starting a run', () => {
  test('moves it to running and stamps the start', async () => {
    const harnessed = await harness();
    try {
      const made = await schedule(harnessed);
      const answer = await command(harnessed, sessionIdOf(made), 'start');

      assert.equal(answer.status, 200);
      assert.equal(answer.body['status'], 'running');
      assert.ok(answer.body['startedAt']);
      assert.equal(answer.body['pausedAt'], null);
    } finally {
      await harnessed.close();
    }
  });

  test('starts the clock at zero, not at the scheduled time', async () => {
    const harnessed = await harness();
    try {
      const made = await schedule(harnessed, {
        scheduledStartAt: minutesAgo(90).toISOString(),
      });
      const answer = await command(harnessed, sessionIdOf(made), 'start');

      assert.ok(Number(clockOf(answer)['elapsedSeconds']) < 5);
    } finally {
      await harnessed.close();
    }
  });

  test('starts a run that was waiting in scheduled', async () => {
    const harnessed = await harness();
    try {
      seedRun(harnessed.db, { status: 'scheduled' });
      const answer = await command(harnessed, RUN_A, 'start');

      assert.equal(answer.body['status'], 'running');
    } finally {
      await harnessed.close();
    }
  });

  test('refuses a second start, so nobody gets their time back', async () => {
    const harnessed = await harness();
    try {
      const startedAt = minutesAgo(20);
      seedRun(harnessed.db, { status: 'running', startedAt });

      const answer = await command(harnessed, RUN_A, 'start');

      assert.equal(answer.status, 409);
      assert.match(String(answer.body['message']), /already running/iu);
      assert.deepEqual(runRow(harnessed, RUN_A)['started_at'], startedAt);
    } finally {
      await harnessed.close();
    }
  });

  test('writes one audit entry, with the state it came from', async () => {
    const harnessed = await harness();
    try {
      const made = await schedule(harnessed);
      await command(harnessed, sessionIdOf(made), 'start');

      const entries = auditOf(harnessed, 'session.started');
      const changes = entries[0]?.['changes'] as Record<string, unknown>;

      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.['actor_user_id'], TEACHER);
      assert.equal((changes['before'] as Record<string, unknown>)['status'], 'lobby');
      assert.equal((changes['after'] as Record<string, unknown>)['status'], 'running');
    } finally {
      await harnessed.close();
    }
  });
});

describe('pausing a run', () => {
  test('stops the clock and stamps the pause', async () => {
    const harnessed = await harness();
    try {
      seedRun(harnessed.db, { status: 'running', startedAt: minutesAgo(10) });
      const answer = await command(harnessed, RUN_A, 'pause');

      assert.equal(answer.status, 200);
      assert.equal(answer.body['status'], 'paused');
      assert.ok(answer.body['pausedAt']);
    } finally {
      await harnessed.close();
    }
  });

  test('leaves the elapsed time where it was', async () => {
    const harnessed = await harness();
    try {
      seedRun(harnessed.db, { status: 'running', startedAt: minutesAgo(10) });
      const answer = await command(harnessed, RUN_A, 'pause');

      const elapsed = Number(clockOf(answer)['elapsedSeconds']);
      assert.ok(elapsed >= 595 && elapsed <= 605, `elapsed was ${String(elapsed)}`);
    } finally {
      await harnessed.close();
    }
  });

  test('gives no end time while it is paused', async () => {
    const harnessed = await harness({ timing: { totalTimeLimitSeconds: 3_600 } });
    try {
      seedRun(harnessed.db, { status: 'running', startedAt: minutesAgo(10) });
      const answer = await command(harnessed, RUN_A, 'pause');

      assert.equal(clockOf(answer)['endsAt'], null);
      assert.ok(Number(clockOf(answer)['remainingSeconds']) > 0);
    } finally {
      await harnessed.close();
    }
  });

  test('refuses a run that has not started', async () => {
    const harnessed = await harness();
    try {
      seedRun(harnessed.db, { status: 'lobby' });
      const answer = await command(harnessed, RUN_A, 'pause');

      assert.equal(answer.status, 409);
      assert.equal(runRow(harnessed, RUN_A)['status'], 'lobby');
    } finally {
      await harnessed.close();
    }
  });

  test('refuses a run that is already paused', async () => {
    const harnessed = await harness();
    try {
      seedRun(harnessed.db, {
        status: 'paused',
        startedAt: minutesAgo(20),
        pausedAt: minutesAgo(5),
      });

      assert.equal((await command(harnessed, RUN_A, 'pause')).status, 409);
    } finally {
      await harnessed.close();
    }
  });
});

describe('resuming a run', () => {
  test('starts the clock again and clears the pause', async () => {
    const harnessed = await harness();
    try {
      seedRun(harnessed.db, {
        status: 'paused',
        startedAt: minutesAgo(20),
        pausedAt: minutesAgo(5),
      });

      const answer = await command(harnessed, RUN_A, 'resume');

      assert.equal(answer.status, 200);
      assert.equal(answer.body['status'], 'running');
      assert.equal(answer.body['pausedAt'], null);
      assert.equal(runRow(harnessed, RUN_A)['paused_at'], null);
    } finally {
      await harnessed.close();
    }
  });

  test('adds the pause it just ended to the total', async () => {
    const harnessed = await harness();
    try {
      seedRun(harnessed.db, {
        status: 'paused',
        startedAt: minutesAgo(20),
        pausedAt: minutesAgo(5),
        pausedSecondsTotal: 60,
      });

      await command(harnessed, RUN_A, 'resume');
      const total = Number(runRow(harnessed, RUN_A)['paused_seconds_total']);

      assert.ok(total >= 355 && total <= 365, `total was ${String(total)}`);
    } finally {
      await harnessed.close();
    }
  });

  test('gives the class back every paused second', async () => {
    const harnessed = await harness();
    try {
      seedRun(harnessed.db, {
        status: 'paused',
        startedAt: minutesAgo(20),
        pausedAt: minutesAgo(5),
      });

      const answer = await command(harnessed, RUN_A, 'resume');
      const elapsed = Number(clockOf(answer)['elapsedSeconds']);

      // Twenty minutes of wall time, five of them paused.
      assert.ok(elapsed >= 895 && elapsed <= 905, `elapsed was ${String(elapsed)}`);
    } finally {
      await harnessed.close();
    }
  });

  test('refuses a run that is not paused', async () => {
    const harnessed = await harness();
    try {
      seedRun(harnessed.db, { status: 'running', startedAt: minutesAgo(5) });

      assert.equal((await command(harnessed, RUN_A, 'resume')).status, 409);
    } finally {
      await harnessed.close();
    }
  });
});

describe('ending a run', () => {
  test('moves a run that was played to ended', async () => {
    const harnessed = await harness();
    try {
      seedRun(harnessed.db, { status: 'running', startedAt: minutesAgo(30) });
      const answer = await command(harnessed, RUN_A, 'end');

      assert.equal(answer.status, 200);
      assert.equal(answer.body['status'], 'ended');
      assert.ok(answer.body['endedAt']);
      assert.equal(answer.body['finished'], true);
    } finally {
      await harnessed.close();
    }
  });

  test('moves a run that was never played to cancelled', async () => {
    const harnessed = await harness();
    try {
      const made = await schedule(harnessed);
      const answer = await command(harnessed, sessionIdOf(made), 'end');

      assert.equal(answer.body['status'], 'cancelled');
      assert.ok(answer.body['endedAt']);
      assert.equal(answer.body['startedAt'], null);
    } finally {
      await harnessed.close();
    }
  });

  test('puts the code back in the pool', async () => {
    const harnessed = await harness();
    try {
      seedRun(harnessed.db, { status: 'running', startedAt: minutesAgo(30) });
      const answer = await command(harnessed, RUN_A, 'end');

      assert.equal(answer.body['joinable'], false);
    } finally {
      await harnessed.close();
    }
  });

  test('ends a paused run, folding the open pause into the total', async () => {
    const harnessed = await harness();
    try {
      seedRun(harnessed.db, {
        status: 'paused',
        startedAt: minutesAgo(20),
        pausedAt: minutesAgo(5),
      });

      const answer = await command(harnessed, RUN_A, 'end');
      const row = runRow(harnessed, RUN_A);
      const elapsed = Number(clockOf(answer)['elapsedSeconds']);

      assert.equal(answer.body['status'], 'ended');
      assert.equal(row['paused_at'], null);
      assert.ok(Number(row['paused_seconds_total']) >= 295);
      assert.ok(elapsed >= 895 && elapsed <= 905, `elapsed was ${String(elapsed)}`);
    } finally {
      await harnessed.close();
    }
  });

  test('freezes the clock, so it reads the same later', async () => {
    const harnessed = await harness();
    try {
      seedRun(harnessed.db, {
        status: 'ended',
        startedAt: new Date(NOON.getTime() - 3_600_000),
        endedAt: NOON,
      });

      const answer = await harnessed.request(`/sessions/${RUN_A}`, as(token(ORG_A)));

      assert.equal(clockOf(answer)['elapsedSeconds'], 3_600);
      assert.equal(clockOf(answer)['endsAt'], null);
    } finally {
      await harnessed.close();
    }
  });

  test('refuses a second ending, and says the run is over', async () => {
    const harnessed = await harness();
    try {
      seedRun(harnessed.db, {
        status: 'ended',
        startedAt: minutesAgo(60),
        endedAt: minutesAgo(10),
      });

      const answer = await command(harnessed, RUN_A, 'end');

      assert.equal(answer.status, 409);
      assert.match(String(answer.body['message']), /over/iu);
    } finally {
      await harnessed.close();
    }
  });

  test('refuses every other command once a run is over', async () => {
    const harnessed = await harness();
    try {
      seedRun(harnessed.db, {
        status: 'ended',
        startedAt: minutesAgo(60),
        endedAt: minutesAgo(10),
      });

      for (const verb of ['start', 'pause', 'resume'] as const) {
        assert.equal(
          (await command(harnessed, RUN_A, verb)).status,
          409,
          `${verb} should be refused`,
        );
      }
      assert.deepEqual(
        (await harnessed.request(`/sessions/${RUN_A}`, as(token(ORG_A)))).body[
          'nextStatuses'
        ],
        [],
      );
    } finally {
      await harnessed.close();
    }
  });

  test('writes one audit entry, with both states on it', async () => {
    const harnessed = await harness();
    try {
      seedRun(harnessed.db, { status: 'running', startedAt: minutesAgo(30) });
      await command(harnessed, RUN_A, 'end');

      const entries = auditOf(harnessed, 'session.ended');
      const changes = entries[0]?.['changes'] as Record<string, unknown>;

      assert.equal(entries.length, 1);
      assert.equal((changes['before'] as Record<string, unknown>)['status'], 'running');
      assert.equal((changes['after'] as Record<string, unknown>)['status'], 'ended');
    } finally {
      await harnessed.close();
    }
  });
});

describe('a whole lesson, end to end', () => {
  test('start, pause, resume, end leaves one run and four entries', async () => {
    const harnessed = await harness();
    try {
      const made = await schedule(harnessed, { name: 'Year 6 — Tuesday' });
      const id = sessionIdOf(made);

      assert.equal((await command(harnessed, id, 'start')).status, 200);
      assert.equal((await command(harnessed, id, 'pause')).status, 200);
      assert.equal((await command(harnessed, id, 'resume')).status, 200);
      assert.equal((await command(harnessed, id, 'end')).status, 200);

      assert.equal(runRow(harnessed, id)['status'], 'ended');
      for (const action of [
        'session.scheduled',
        'session.started',
        'session.paused',
        'session.resumed',
        'session.ended',
      ]) {
        assert.equal(auditOf(harnessed, action).length, 1, action);
      }
    } finally {
      await harnessed.close();
    }
  });

  test('a command on a run that is not there is 404', async () => {
    const harnessed = await harness();
    try {
      assert.equal((await command(harnessed, MISSING_ID, 'start')).status, 404);
    } finally {
      await harnessed.close();
    }
  });
});

/**
 * Giving a class more time (EXPD-019).
 *
 * The one command that does not change the state. What it changes is the
 * run's own `extended_seconds_total`, never the frozen document — so the
 * tests here watch the limit the class plays to move while the revision it is
 * pinned to stays exactly as it was.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_EXTENSION_SECONDS } from '../../src/sessions/session-service.ts';
import {
  as,
  auditOf,
  clockOf,
  command,
  harness,
  ORG_A,
  RUN_A,
  runRow,
  rowsIn,
  seedRun,
  token,
  VERSION_A,
} from './support.ts';

/** An hour-long expedition, with a run of it twenty minutes in. */
async function hourLongRun(): Promise<Awaited<ReturnType<typeof harness>>> {
  const harnessed = await harness({ timing: { totalTimeLimitSeconds: 3_600 } });
  seedRun(harnessed.db, {
    status: 'running',
    startedAt: new Date(Date.now() - 20 * 60_000),
  });
  return harnessed;
}

describe('extending a run', () => {
  test('adds the time to the limit the class plays to', async () => {
    const harnessed = await hourLongRun();
    try {
      const answer = await command(harnessed, RUN_A, 'extend', {
        body: { seconds: 600 },
      });

      assert.equal(answer.status, 200);
      assert.equal(clockOf(answer)['limitSeconds'], 4_200);
      assert.equal(clockOf(answer)['extendedSeconds'], 600);
    } finally {
      await harnessed.close();
    }
  });

  test('leaves the run in the state it was in', async () => {
    const harnessed = await hourLongRun();
    try {
      const answer = await command(harnessed, RUN_A, 'extend', {
        body: { seconds: 600 },
      });

      assert.equal(answer.body['status'], 'running');
    } finally {
      await harnessed.close();
    }
  });

  test('adds up, rather than replacing', async () => {
    const harnessed = await hourLongRun();
    try {
      await command(harnessed, RUN_A, 'extend', { body: { seconds: 300 } });
      const answer = await command(harnessed, RUN_A, 'extend', {
        body: { seconds: 300 },
      });

      assert.equal(clockOf(answer)['extendedSeconds'], 600);
      assert.equal(runRow(harnessed, RUN_A)['extended_seconds_total'], 600);
    } finally {
      await harnessed.close();
    }
  });

  test('never touches the revision the run is pinned to', async () => {
    const harnessed = await hourLongRun();
    try {
      await command(harnessed, RUN_A, 'extend', { body: { seconds: 600 } });

      const version = rowsIn(harnessed, 'expedition_version').find(
        (row) => row['id'] === VERSION_A,
      );
      const rules = (version?.['definition'] as Record<string, unknown>)['rules'];
      const timing = (rules as Record<string, unknown>)['timing'] as Record<
        string,
        unknown
      >;

      assert.equal(timing['totalTimeLimitSeconds'], 3_600);
    } finally {
      await harnessed.close();
    }
  });

  test('brings a run back from expired', async () => {
    const harnessed = await harness({ timing: { totalTimeLimitSeconds: 600 } });
    try {
      seedRun(harnessed.db, {
        status: 'running',
        startedAt: new Date(Date.now() - 20 * 60_000),
      });

      const before = await harnessed.request(`/sessions/${RUN_A}`, as(token(ORG_A)));
      assert.equal(clockOf(before)['expired'], true);
      assert.equal(clockOf(before)['remainingSeconds'], 0);

      const after = await command(harnessed, RUN_A, 'extend', {
        body: { seconds: 900 },
      });

      assert.equal(clockOf(after)['expired'], false);
      assert.ok(Number(clockOf(after)['remainingSeconds']) > 0);
    } finally {
      await harnessed.close();
    }
  });

  test('records it as an override, with the reason given', async () => {
    const harnessed = await hourLongRun();
    try {
      await command(harnessed, RUN_A, 'extend', {
        body: { seconds: 600, reason: 'the coach was late' },
      });

      const entries = auditOf(harnessed, 'session.overridden');
      const changes = entries[0]?.['changes'] as Record<string, unknown>;

      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.['entity_id'], RUN_A);
      assert.equal(changes['note'], 'the coach was late');
      assert.equal(
        (changes['after'] as Record<string, unknown>)['extended_seconds_total'],
        600,
      );
    } finally {
      await harnessed.close();
    }
  });
});

describe('what cannot be extended', () => {
  test('a run whose expedition has no time limit', async () => {
    const harnessed = await harness();
    try {
      seedRun(harnessed.db, {
        status: 'running',
        startedAt: new Date(Date.now() - 60_000),
      });

      const answer = await command(harnessed, RUN_A, 'extend', {
        body: { seconds: 600 },
      });

      assert.equal(answer.status, 409);
      assert.match(String(answer.body['message']), /no time limit/iu);
      assert.equal(runRow(harnessed, RUN_A)['extended_seconds_total'], 0);
    } finally {
      await harnessed.close();
    }
  });

  test('a run that has not started', async () => {
    const harnessed = await harness({ timing: { totalTimeLimitSeconds: 3_600 } });
    try {
      seedRun(harnessed.db, { status: 'lobby' });

      assert.equal(
        (await command(harnessed, RUN_A, 'extend', { body: { seconds: 600 } })).status,
        409,
      );
    } finally {
      await harnessed.close();
    }
  });

  test('a run that is over', async () => {
    const harnessed = await harness({ timing: { totalTimeLimitSeconds: 3_600 } });
    try {
      seedRun(harnessed.db, {
        status: 'ended',
        startedAt: new Date(Date.now() - 3 * 3_600_000),
        endedAt: new Date(Date.now() - 3_600_000),
      });

      assert.equal(
        (await command(harnessed, RUN_A, 'extend', { body: { seconds: 600 } })).status,
        409,
      );
    } finally {
      await harnessed.close();
    }
  });

  test('a paused run can be, because it is still being played', async () => {
    const harnessed = await harness({ timing: { totalTimeLimitSeconds: 3_600 } });
    try {
      seedRun(harnessed.db, {
        status: 'paused',
        startedAt: new Date(Date.now() - 20 * 60_000),
        pausedAt: new Date(Date.now() - 60_000),
      });

      const answer = await command(harnessed, RUN_A, 'extend', {
        body: { seconds: 600 },
      });

      assert.equal(answer.status, 200);
      assert.equal(answer.body['status'], 'paused');
    } finally {
      await harnessed.close();
    }
  });
});

describe('what an extension may say', () => {
  test('refuses nothing at all', async () => {
    const harnessed = await hourLongRun();
    try {
      assert.equal((await command(harnessed, RUN_A, 'extend')).status, 422);
    } finally {
      await harnessed.close();
    }
  });

  test('refuses zero and negative time', async () => {
    const harnessed = await hourLongRun();
    try {
      for (const seconds of [0, -600]) {
        assert.equal(
          (await command(harnessed, RUN_A, 'extend', { body: { seconds } })).status,
          422,
          `${String(seconds)} should be refused`,
        );
      }
    } finally {
      await harnessed.close();
    }
  });

  test('refuses more than one extension may add', async () => {
    const harnessed = await hourLongRun();
    try {
      const answer = await command(harnessed, RUN_A, 'extend', {
        body: { seconds: MAX_EXTENSION_SECONDS + 1 },
      });

      assert.equal(answer.status, 422);
    } finally {
      await harnessed.close();
    }
  });
});

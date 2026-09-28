/**
 * Playing a QR hunt mission through the API (EXPD-032).
 *
 * `createApp` is built with no mission types of its own, so the QR hunt is
 * the one the platform ships (`PLATFORM_MISSION_TYPES`). There is no
 * `qr-hunt` row seeded either: the code judges the scans without one.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../../src/app.ts';
import { FakeDatabase } from '../support/fake-database.ts';
import { listen, send, type Answer, type RunningApp } from '../http/support.ts';
import { ASHA, CONFIG, RUN_A, missionIn, phone, refusalOf, scoreOf, seed } from './support.ts';

const TRAIL = {
  purpose: 'progression',
  markers: [
    { code: 'LIB-01', label: 'Library window' },
    { code: 'POND-02', label: 'By the pond' },
  ],
};

async function playing(): Promise<{
  app: RunningApp;
  post: (path: string, body?: unknown) => Promise<Answer>;
}> {
  const db = new FakeDatabase();
  seed(db, { gate: { type: 'qr-hunt', config: TRAIL } });
  const app = await listen(createApp({ db, authConfig: CONFIG }));
  const post = (path: string, body?: unknown) =>
    send(app, `/sessions/${RUN_A}/missions/gate/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${phone(ASHA)}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { app, post };
}

describe('a QR hunt mission in a run', () => {
  test('is judged by the platform type, and a finished trail completes it', async () => {
    const { app, post } = await playing();
    try {
      assert.equal((await post('attempts')).status, 201);
      const answer = await post('submissions', { payload: { scanned: ['LIB-01', 'pond-02'] } });

      assert.equal(answer.status, 201);
      const verdict = answer.body['verdict'] as Record<string, unknown>;
      assert.equal(verdict['outcome'], 'correct');
      assert.equal(verdict['method'], 'behaviour');
      assert.equal(verdict['feedback'], 'Trail complete.');
      assert.equal(missionIn(answer)['state'], 'complete');
      assert.equal(scoreOf(answer).total > 0, true);
    } finally {
      await app.close();
    }
  });

  test('turns a trail walked out of order away, and says how far the team got', async () => {
    const { app, post } = await playing();
    try {
      await post('attempts');
      const answer = await post('submissions', { payload: { scanned: ['POND-02'] } });

      assert.equal(answer.status, 201);
      const verdict = answer.body['verdict'] as Record<string, unknown>;
      assert.equal(verdict['outcome'], 'incorrect');
      assert.equal(verdict['feedback'], '0 of 2 markers found in order.');
      assert.notEqual(missionIn(answer)['state'], 'complete');
    } finally {
      await app.close();
    }
  });

  test('refuses a submission that is not a list of scans', async () => {
    const { app, post } = await playing();
    try {
      await post('attempts');
      const answer = await post('submissions', { payload: { code: 'LIB-01' } });
      assert.equal(refusalOf(answer), 'invalid-submission');
    } finally {
      await app.close();
    }
  });
});

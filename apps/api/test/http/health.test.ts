/**
 * The health checks (EXPD-016).
 *
 * Two promises worth holding to. `/health` answers while the process is
 * alive and asks nothing of anything outside it, because App Service restarts
 * an instance whose liveness probe fails and a database wobble must not
 * become a rolling restart. `/health/ready` does ask, and says 503 when the
 * answer does not come.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

import { ENGINE_VERSION } from '@explorer/engine';

import express from 'express';

import { createApp, type AppOptions } from '../../src/app.ts';
import { signingKey } from '../../src/auth/tokens.ts';
import { DEFAULT_LIFETIMES, type AuthConfig } from '../../src/config/auth-config.ts';
import type { Queryable, QueryResult, QueryResultRow } from '../../src/db/queryable.ts';
import { API_VERSION, createHealthRouter } from '../../src/http/health.ts';
import { listen, send, type RunningApp } from './support.ts';

/**
 * Auth settings the test supplies itself.
 *
 * `createApp` mounts the sign-in routes whenever it is given a database, and
 * those read `AUTH_TOKEN_SECRET` from the environment unless they are handed
 * a configuration. Nothing here signs in; this only keeps the environment out
 * of a test about health checks.
 */
const CONFIG: AuthConfig = {
  signingKey: signingKey('h'.repeat(32)),
  lifetimes: DEFAULT_LIFETIMES,
};

/** `createApp`, with the auth settings every test here needs and none uses. */
function apiApp(options: AppOptions = {}): express.Express {
  return createApp({ ...options, authConfig: CONFIG });
}

/** A database that answers `SELECT 1` and remembers being asked. */
function healthyDatabase(): Queryable & { readonly statements: string[] } {
  const statements: string[] = [];
  return {
    statements,
    async query<TRow extends QueryResultRow>(text: string): Promise<QueryResult<TRow>> {
      statements.push(text);
      return { rows: [] as TRow[], rowCount: 1 };
    },
  };
}

/** A database that is there but refuses. */
const brokenDatabase: Queryable = {
  query: () => Promise.reject(new Error('connection refused')),
};

/** A database that never answers at all. */
const hangingDatabase: Queryable = {
  query: () => new Promise(() => {}),
};

const running: RunningApp[] = [];

async function start(app: express.Express): Promise<RunningApp> {
  const started = await listen(app);
  running.push(started);
  return started;
}

after(async () => {
  await Promise.all(running.map((app) => app.close()));
});

describe('liveness', () => {
  test('answers ok with no database configured at all', async () => {
    const app = await start(apiApp());
    const answer = await send(app, '/health');

    assert.equal(answer.status, 200);
    assert.equal(answer.body['status'], 'ok');
    assert.equal(answer.body['engineVersion'], ENGINE_VERSION);
    assert.equal(answer.body['apiVersion'], API_VERSION);
    assert.equal(typeof answer.body['uptimeSeconds'], 'number');
  });

  test('still says `"status":"ok"`, which is what the packaging script greps for', async () => {
    const app = await start(apiApp());
    const answer = await send(app, '/health');

    // `scripts/package-api.sh` checks the raw text for this. If the shape of
    // the answer changes, the build of the deployment package fails, which is
    // why the exact substring is asserted rather than the parsed field.
    assert.ok(answer.text.includes('"status":"ok"'), answer.text);
  });

  test('asks the database nothing, even when the database is broken', async () => {
    const app = await start(apiApp({ db: brokenDatabase }));
    const answer = await send(app, '/health');

    assert.equal(answer.status, 200);
    assert.equal(answer.body['status'], 'ok');
  });

  test('answers the same at /health/live', async () => {
    const app = await start(apiApp());
    const answer = await send(app, '/health/live');

    assert.equal(answer.status, 200);
    assert.equal(answer.body['status'], 'ok');
  });

  test('needs no token', async () => {
    const app = await start(apiApp({ db: healthyDatabase() }));
    const answer = await send(app, '/health');

    assert.equal(answer.status, 200);
  });
});

describe('readiness', () => {
  test('reports a database that answers', async () => {
    const db = healthyDatabase();
    const app = await start(apiApp({ db }));
    const answer = await send(app, '/health/ready');

    assert.equal(answer.status, 200);
    assert.equal(answer.body['status'], 'ok');
    assert.deepEqual(answer.body['checks'], { database: 'ok' });
    assert.deepEqual(db.statements, ['SELECT 1']);
  });

  test('answers 503 when the database refuses', async () => {
    const app = await start(apiApp({ db: brokenDatabase }));
    const answer = await send(app, '/health/ready');

    assert.equal(answer.status, 503);
    assert.equal(answer.body['status'], 'unavailable');
    assert.deepEqual(answer.body['checks'], { database: 'failed' });
  });

  test('says nothing about why it failed', async () => {
    const app = await start(apiApp({ db: brokenDatabase }));
    const answer = await send(app, '/health/ready');

    assert.ok(!answer.text.includes('connection refused'), answer.text);
  });

  test('gives up on a database that never answers', async () => {
    const app = express();
    app.use(createHealthRouter({ db: hangingDatabase, readinessTimeoutMs: 20 }));
    const started = await start(app);

    const answer = await send(started, '/health/ready');
    assert.equal(answer.status, 503);
    assert.deepEqual(answer.body['checks'], { database: 'failed' });
  });

  test('is ok, and says so, when no database is configured', async () => {
    const app = await start(apiApp());
    const answer = await send(app, '/health/ready');

    assert.equal(answer.status, 200);
    assert.equal(answer.body['status'], 'ok');
    assert.deepEqual(answer.body['checks'], { database: 'not-configured' });
  });
});

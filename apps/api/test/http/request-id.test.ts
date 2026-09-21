/**
 * The request id (EXPD-016).
 *
 * The promise: every response carries one, whatever happened, and the audit
 * log (EXPD-006) records the same one the caller was shown.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

import express from 'express';

import { createApp } from '../../src/app.ts';
import {
  MAX_REQUEST_ID_LENGTH,
  REQUEST_ID_HEADER,
  requestId,
  requestIdOf,
} from '../../src/http/request-id.ts';
import {
  listen,
  postJson,
  recordingLogger,
  send,
  skeletonApp,
  type RunningApp,
} from './support.ts';

const running: RunningApp[] = [];

async function start(app: express.Express): Promise<RunningApp> {
  const started = await listen(app);
  running.push(started);
  return started;
}

after(async () => {
  await Promise.all(running.map((app) => app.close()));
});

/** An app that hands back whichever id the middleware settled on. */
async function echoApp(): Promise<RunningApp> {
  const app = express();
  app.use(requestId());
  app.get('/echo', (request, response) => {
    response.json({ seen: requestIdOf(request) });
  });
  return start(app);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('minting an id', () => {
  test('makes one up when the caller sent none', async () => {
    const answer = await send(await echoApp(), '/echo');

    const header = answer.headers.get(REQUEST_ID_HEADER);
    assert.match(header ?? '', UUID);
    assert.equal(answer.body['seen'], header);
  });

  test('gives a different one to each request', async () => {
    const app = await echoApp();
    const first = await send(app, '/echo');
    const second = await send(app, '/echo');

    assert.notEqual(first.body['seen'], second.body['seen']);
  });
});

describe('an id the caller sent', () => {
  test('is kept, so both sides of the hop agree', async () => {
    const app = await echoApp();
    const answer = await send(app, '/echo', {
      headers: { [REQUEST_ID_HEADER]: 'trace-from-the-proxy' },
    });

    assert.equal(answer.headers.get(REQUEST_ID_HEADER), 'trace-from-the-proxy');
    assert.equal(answer.body['seen'], 'trace-from-the-proxy');
  });

  test('is trimmed rather than refused when it is absurdly long', async () => {
    const app = await echoApp();
    const answer = await send(app, '/echo', {
      headers: { [REQUEST_ID_HEADER]: 'x'.repeat(MAX_REQUEST_ID_LENGTH + 500) },
    });

    assert.equal(answer.status, 200);
    assert.equal((answer.body['seen'] as string).length, MAX_REQUEST_ID_LENGTH);
  });

  test('is replaced when it is only whitespace', async () => {
    const app = await echoApp();
    const answer = await send(app, '/echo', { headers: { [REQUEST_ID_HEADER]: '   ' } });

    assert.match(answer.body['seen'] as string, UUID);
  });
});

describe('the id is on every answer', () => {
  test('including a 404', async () => {
    const answer = await send(await start(createApp()), '/nothing-here');

    assert.equal(answer.status, 404);
    assert.match(answer.headers.get(REQUEST_ID_HEADER) ?? '', UUID);
  });

  test('including a 500', async () => {
    const logger = recordingLogger();
    const started = await start(
      skeletonApp((app) => {
        app.get('/boom', () => {
          throw new Error('the handler fell over');
        });
      }, { log: logger.log }),
    );

    const answer = await send(started, '/boom');
    assert.equal(answer.status, 500);
    assert.match(answer.headers.get(REQUEST_ID_HEADER) ?? '', UUID);
  });

  test('the id in the log line is the id the caller was shown', async () => {
    const logger = recordingLogger();
    const started = await start(
      skeletonApp((app) => {
        app.get('/boom', () => {
          throw new Error('the handler fell over');
        });
      }, { log: logger.log }),
    );

    const answer = await send(started, '/boom', {
      headers: { [REQUEST_ID_HEADER]: 'the-one-they-quoted' },
    });

    assert.equal(answer.headers.get(REQUEST_ID_HEADER), 'the-one-they-quoted');
    assert.equal(logger.lines.length, 1);
    assert.match(logger.lines[0]?.line ?? '', /the-one-they-quoted/);
  });

  test('including a health check', async () => {
    const answer = await send(await start(createApp()), '/health');

    assert.match(answer.headers.get(REQUEST_ID_HEADER) ?? '', UUID);
  });

  test('including a request with a body', async () => {
    const answer = await send(await start(createApp()), '/nope', postJson({ a: 1 }));

    assert.match(answer.headers.get(REQUEST_ID_HEADER) ?? '', UUID);
  });
});

describe('reading the id back', () => {
  test('falls back to the header for a request that never met the middleware', async () => {
    const app = express();
    app.get('/bare', (request, response) => {
      response.json({ seen: requestIdOf(request) });
    });
    const started = await start(app);

    const answer = await send(started, '/bare', {
      headers: { [REQUEST_ID_HEADER]: 'from-the-header' },
    });
    assert.equal(answer.body['seen'], 'from-the-header');
  });

  test('is null when there is neither', async () => {
    const app = express();
    app.get('/bare', (request, response) => {
      response.json({ seen: requestIdOf(request) });
    });
    const started = await start(app);

    const answer = await send(started, '/bare');
    assert.equal(answer.body['seen'], null);
  });
});

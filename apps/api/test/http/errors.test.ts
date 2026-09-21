/**
 * The error contract (EXPD-016).
 *
 * One body, whatever went wrong and whoever raised it:
 *
 *     { "error": "<code>", "message": "<English>", "details"?: [...] }
 *
 * The tests below try every way a request can fail that the skeleton knows
 * about — a path nobody claimed, an unreadable body, a body over the limit, a
 * handler that throws on purpose, a handler that throws by accident, an
 * `async` handler that rejects, and an `AuthError` from EXPD-004 — and check
 * that they all come back in that shape.
 *
 * The one that matters most is the accident. A fault must say nothing: not
 * the message, not the stack, not the name of a table.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

import express from 'express';

import { createApp } from '../../src/app.ts';
import { AuthError } from '../../src/auth/errors.ts';
import { ApiError, ValidationError, notFound } from '../../src/http/errors.ts';
import { listen, postJson, recordingLogger, send, skeletonApp, type RunningApp } from './support.ts';

const running: RunningApp[] = [];

async function start(app: express.Express): Promise<RunningApp> {
  const started = await listen(app);
  running.push(started);
  return started;
}

after(async () => {
  await Promise.all(running.map((app) => app.close()));
});

describe('a path nobody claimed', () => {
  test('is a 404 in the error contract, not Express’s HTML page', async () => {
    const answer = await send(await start(createApp()), '/expeditions');

    assert.equal(answer.status, 404);
    assert.equal(answer.headers.get('content-type')?.startsWith('application/json'), true);
    assert.equal(answer.body['error'], 'not-found');
    assert.match(answer.body['message'] as string, /GET \/expeditions/);
  });

  test('covers a method the path does not answer to', async () => {
    const answer = await send(await start(createApp()), '/health', { method: 'DELETE' });

    assert.equal(answer.status, 404);
    assert.equal(answer.body['error'], 'not-found');
  });

  test('says nothing about which routes do exist', async () => {
    const answer = await send(await start(createApp()), '/auth/sign-in');

    assert.equal(answer.status, 404);
    assert.equal(Object.keys(answer.body).sort().join(','), 'error,message');
  });
});

describe('a body the API cannot read', () => {
  test('is a 400, not a 500', async () => {
    const started = await start(skeletonApp((app) => {
      app.post('/thing', (_request, response) => response.json({ ok: true }));
    }));

    const answer = await send(started, '/thing', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ "name": ',
    });

    assert.equal(answer.status, 400);
    assert.equal(answer.body['error'], 'bad-request');
    assert.equal(answer.body['message'], 'That request body is not valid JSON.');
  });

  test('over the size limit is a 413', async () => {
    const started = await start(skeletonApp((app) => {
      app.post('/thing', (_request, response) => response.json({ ok: true }));
    }));

    const answer = await send(
      started,
      '/thing',
      postJson({ padding: 'x'.repeat(2 * 1024 * 1024) }),
    );

    assert.equal(answer.status, 413);
    assert.equal(answer.body['error'], 'payload-too-large');
  });
});

describe('a handler refusing on purpose', () => {
  test('answers with the failure it named', async () => {
    const started = await start(skeletonApp((app) => {
      app.get('/gone', () => {
        throw notFound('expedition');
      });
      app.get('/clash', () => {
        throw new ApiError('conflict', { message: 'That join code is already in use.' });
      });
    }));

    const gone = await send(started, '/gone');
    assert.equal(gone.status, 404);
    assert.equal(gone.body['error'], 'not-found');
    assert.equal(gone.body['message'], 'There is no expedition with that id.');

    const clash = await send(started, '/clash');
    assert.equal(clash.status, 409);
    assert.equal(clash.body['error'], 'conflict');
    assert.equal(clash.body['message'], 'That join code is already in use.');
  });

  test('carries details only when it is a validation failure', async () => {
    const started = await start(skeletonApp((app) => {
      app.get('/invalid', () => {
        throw new ValidationError([{ path: 'name', message: 'This is required.' }]);
      });
      app.get('/gone', () => {
        throw notFound();
      });
    }));

    const invalid = await send(started, '/invalid');
    assert.equal(invalid.status, 422);
    assert.deepEqual(invalid.body['details'], [
      { path: 'name', message: 'This is required.' },
    ]);

    const gone = await send(started, '/gone');
    assert.equal(Object.hasOwn(gone.body, 'details'), false);
  });

  test('keeps the private detail out of the answer', async () => {
    const started = await start(skeletonApp((app) => {
      app.get('/gone', () => {
        throw new ApiError('not-found', { detail: 'row 42 belongs to another org' });
      });
    }));

    const answer = await send(started, '/gone');
    assert.ok(!answer.text.includes('row 42'), answer.text);
  });

  test('logs a 5xx it raised deliberately, and not a 4xx', async () => {
    const logger = recordingLogger();
    const started = await start(
      skeletonApp((app) => {
        app.get('/down', () => {
          throw new ApiError('service-unavailable');
        });
        app.get('/gone', () => {
          throw notFound();
        });
      }, { log: logger.log }),
    );

    await send(started, '/gone');
    assert.equal(logger.lines.length, 0);

    const down = await send(started, '/down');
    assert.equal(down.status, 503);
    assert.equal(logger.lines.length, 1);
  });
});

describe('a handler failing by accident', () => {
  test('is a 500 that gives nothing away', async () => {
    const logger = recordingLogger();
    const started = await start(
      skeletonApp((app) => {
        app.get('/boom', () => {
          throw new Error('relation "expedition" does not exist');
        });
      }, { log: logger.log }),
    );

    const answer = await send(started, '/boom');

    assert.equal(answer.status, 500);
    assert.deepEqual(answer.body, {
      error: 'internal-error',
      message: 'Something went wrong on our side.',
    });
    assert.ok(!answer.text.includes('relation'), answer.text);
  });

  test('is written to the log in full', async () => {
    const logger = recordingLogger();
    const started = await start(
      skeletonApp((app) => {
        app.get('/boom', () => {
          throw new Error('relation "expedition" does not exist');
        });
      }, { log: logger.log }),
    );

    await send(started, '/boom');

    assert.equal(logger.lines.length, 1);
    assert.match(logger.lines[0]?.line ?? '', /GET \/boom/);
    assert.equal((logger.lines[0]?.error as Error).message, 'relation "expedition" does not exist');
  });

  test('catches a rejected promise from an async handler, with no wrapper', async () => {
    const logger = recordingLogger();
    const started = await start(
      skeletonApp((app) => {
        app.get('/boom', async () => {
          await Promise.resolve();
          throw new Error('the query never came back');
        });
      }, { log: logger.log }),
    );

    const answer = await send(started, '/boom');

    assert.equal(answer.status, 500);
    assert.equal(answer.body['error'], 'internal-error');
    assert.equal(logger.lines.length, 1);
  });

  test('still reports an ApiError thrown from an async handler as itself', async () => {
    const started = await start(skeletonApp((app) => {
      app.get('/gone', async () => {
        await Promise.resolve();
        throw notFound('team');
      });
    }));

    const answer = await send(started, '/gone');
    assert.equal(answer.status, 404);
    assert.equal(answer.body['error'], 'not-found');
  });

  test('does not try to answer twice when the response has already gone', async () => {
    const logger = recordingLogger();
    const started = await start(
      skeletonApp((app) => {
        app.get('/half', (_request, response) => {
          response.status(200).json({ ok: true });
          throw new Error('after the fact');
        });
      }, { log: logger.log }),
    );

    const answer = await send(started, '/half');
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, { ok: true });
  });
});

describe('an AuthError from EXPD-004', () => {
  test('keeps its own code and status', async () => {
    const started = await start(skeletonApp((app) => {
      app.get('/secret', () => {
        throw new AuthError('forbidden', 'principal lacks expedition:publish');
      });
    }));

    const answer = await send(started, '/secret');

    assert.equal(answer.status, 403);
    assert.equal(answer.body['error'], 'forbidden');
    assert.equal(answer.body['message'], 'You do not have permission to do that.');
  });

  test('gets the WWW-Authenticate header a 401 needs', async () => {
    const started = await start(skeletonApp((app) => {
      app.get('/secret', () => {
        throw new AuthError('no-credentials');
      });
    }));

    const answer = await send(started, '/secret');

    assert.equal(answer.status, 401);
    assert.equal(answer.headers.get('www-authenticate'), 'Bearer');
  });

  test('is not logged as a fault', async () => {
    const logger = recordingLogger();
    const started = await start(
      skeletonApp((app) => {
        app.get('/secret', () => {
          throw new AuthError('bad-token');
        });
      }, { log: logger.log }),
    );

    await send(started, '/secret');
    assert.equal(logger.lines.length, 0);
  });

  test('keeps its private detail out of the answer', async () => {
    const started = await start(skeletonApp((app) => {
      app.get('/secret', () => {
        throw new AuthError('forbidden', 'principal lacks expedition:publish');
      });
    }));

    const answer = await send(started, '/secret');
    assert.ok(!answer.text.includes('expedition:publish'), answer.text);
  });
});

describe('the app itself', () => {
  test('does not announce what it is built on', async () => {
    const answer = await send(await start(createApp()), '/health');

    assert.equal(answer.headers.get('x-powered-by'), null);
  });
});

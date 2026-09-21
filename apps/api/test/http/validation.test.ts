/**
 * Request validation (EXPD-016).
 *
 * Three promises. A handler behind `validateBody` never sees a request that
 * failed it. Everything wrong is reported at once, each with the path to the
 * field. And a field the API does not know is refused rather than ignored,
 * because a misspelled field that silently does nothing is the worst kind of
 * bug to be on the receiving end of.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

import express from 'express';

import {
  array,
  boolean,
  bodyOf,
  definition,
  id,
  integer,
  object,
  oneOf,
  optional,
  paramsOf,
  queryOf,
  string,
  timestamp,
  unchecked,
  validateBody,
  validateParams,
  validateQuery,
  withDefault,
  type Checker,
  type FieldIssue,
} from '../../src/http/index.ts';
import { listen, postJson, send, skeletonApp, type RunningApp } from './support.ts';

const running: RunningApp[] = [];

async function start(app: express.Express): Promise<RunningApp> {
  const started = await listen(app);
  running.push(started);
  return started;
}

after(async () => {
  await Promise.all(running.map((app) => app.close()));
});

/** Runs a checker on its own, without an HTTP request around it. */
function check<TValue>(checker: Checker<TValue>, value: unknown) {
  return checker.check(value, '');
}

/** The issues a checker reported, as `path: message` pairs. */
function issuesOf(result: { ok: boolean; issues?: readonly FieldIssue[] }): string[] {
  return (result.issues ?? []).map((issue) => `${issue.path}: ${issue.message}`);
}

describe('the checkers', () => {
  test('string bounds its length and trims by default', () => {
    const checker = string({ min: 1, max: 5 });

    assert.deepEqual(check(checker, '  hi  '), { ok: true, value: 'hi' });
    assert.equal(check(checker, '   ').ok, false);
    assert.equal(check(checker, 'far too long').ok, false);
    assert.equal(check(checker, 42).ok, false);
  });

  test('string can be held to a pattern, with a message of its own', () => {
    const code = string({
      pattern: /^[A-Z]{4}$/,
      patternMessage: 'A join code is four capital letters.',
    });

    assert.equal(check(code, 'WXYZ').ok, true);
    assert.deepEqual(issuesOf(check(code, 'wxyz')), [
      ': A join code is four capital letters.',
    ]);
  });

  test('integer reads a number out of a query string, and bounds it', () => {
    const checker = integer({ min: 1, max: 100 });

    assert.deepEqual(check(checker, '25'), { ok: true, value: 25 });
    assert.equal(check(checker, 2.5).ok, false);
    assert.equal(check(checker, 0).ok, false);
    assert.equal(check(checker, 101).ok, false);
    assert.equal(check(checker, 'twelve').ok, false);
  });

  test('boolean accepts the way a query string spells one', () => {
    assert.deepEqual(check(boolean(), 'true'), { ok: true, value: true });
    assert.deepEqual(check(boolean(), false), { ok: true, value: false });
    assert.equal(check(boolean(), 'yes').ok, false);
  });

  test('oneOf lists what it would have accepted', () => {
    const checker = oneOf(['draft', 'published'] as const);

    assert.deepEqual(check(checker, 'draft'), { ok: true, value: 'draft' });
    assert.deepEqual(issuesOf(check(checker, 'archived')), [
      ': This has to be one of: draft, published.',
    ]);
  });

  test('id takes a UUID and nothing else', () => {
    assert.equal(check(id(), '3f2504e0-4f89-41d3-9a0c-0305e82c3301').ok, true);
    assert.equal(check(id(), '42').ok, false);
    assert.equal(check(id(), 'DROP TABLE team').ok, false);
  });

  test('timestamp hands on a Date', () => {
    const result = check(timestamp(), '2026-03-01T09:00:00Z');

    assert.equal(result.ok, true);
    assert.equal(
      result.ok ? result.value.toISOString() : null,
      '2026-03-01T09:00:00.000Z',
    );
    assert.equal(check(timestamp(), 'next tuesday').ok, false);
  });

  test('array checks every entry and names each by its index', () => {
    const checker = array(integer({ min: 0 }), { max: 3 });

    assert.deepEqual(check(checker, [1, 2]), { ok: true, value: [1, 2] });
    assert.deepEqual(issuesOf(check(checker, [1, 'two', -3])), [
      '[1]: This has to be a whole number.',
      '[2]: This has to be 0 or more.',
    ]);
    assert.equal(check(checker, [1, 2, 3, 4]).ok, false);
    assert.equal(check(checker, 'not a list').ok, false);
  });

  test('optional lets a field be left out; withDefault stands in for it', () => {
    const shape = object({
      name: string({ min: 1 }),
      notes: optional(string()),
      limit: withDefault(integer(), 20),
    });

    assert.deepEqual(check(shape, { name: 'Harbour hunt' }), {
      ok: true,
      value: { name: 'Harbour hunt', limit: 20 },
    });
  });

  test('a null reads the same as a field left out', () => {
    const shape = object({ notes: optional(string()), name: string({ min: 1 }) });

    assert.deepEqual(check(shape, { name: 'x', notes: null }), {
      ok: true,
      value: { name: 'x' },
    });
    assert.deepEqual(issuesOf(check(shape, { name: null })), ['name: This is required.']);
  });

  test('unchecked hands a value on untouched', () => {
    const value = { anything: [1, { deep: true }] };
    assert.deepEqual(check(unchecked(), value), { ok: true, value });
  });

  test('definition defers to a validator somebody else wrote', () => {
    const checker = definition<{ id: string }>(
      (value) =>
        typeof value === 'object' && value !== null && 'id' in value
          ? { valid: true }
          : { valid: false, issues: [{ path: 'id', message: 'missing' }] },
      (issues, path) =>
        (issues as { path: string; message: string }[]).map((issue) => ({
          path: path === '' ? issue.path : `${path}.${issue.path}`,
          message: issue.message,
        })),
    );

    assert.equal(check(checker, { id: 'x' }).ok, true);
    assert.deepEqual(issuesOf(checker.check({}, 'definition')), [
      'definition.id: missing',
    ]);
  });
});

describe('objects', () => {
  test('report every problem at once', () => {
    const shape = object({
      name: string({ min: 1, max: 4 }),
      missions: integer({ min: 1 }),
      visibility: oneOf(['private', 'organisation'] as const),
    });

    assert.deepEqual(issuesOf(check(shape, { name: '', missions: 0 })), [
      'name: This cannot be empty.',
      'missions: This has to be 1 or more.',
      'visibility: This is required.',
    ]);
  });

  test('refuse a field they do not know rather than ignoring it', () => {
    const shape = object({ title: string({ min: 1 }) });

    assert.deepEqual(issuesOf(check(shape, { title: 'x', tittle: 'y' })), [
      'tittle: This field is not recognised.',
    ]);
  });

  test('name a nested field by its full path', () => {
    const shape = object({
      rules: object({ hints: array(object({ cost: integer({ min: 0 }) })) }),
    });

    assert.deepEqual(issuesOf(check(shape, { rules: { hints: [{ cost: -1 }] } })), [
      'rules.hints[0].cost: This has to be 0 or more.',
    ]);
  });

  test('refuse a list or a null where an object belongs', () => {
    const shape = object({ title: string() });

    assert.equal(check(shape, []).ok, false);
    assert.equal(check(shape, null).ok, false);
    assert.equal(check(shape, 'text').ok, false);
  });
});

describe('in front of a route', () => {
  const Body = object({
    name: string({ min: 1, max: 120 }),
    teamSize: integer({ min: 1, max: 8 }),
    notes: optional(string({ max: 200 })),
  });

  const Query = object({ limit: withDefault(integer({ min: 1, max: 50 }), 20) });

  const Params = object({ expeditionId: id() });

  async function routed(): Promise<RunningApp> {
    return start(
      skeletonApp((app) => {
        app.post('/expeditions', validateBody(Body), (request, response) => {
          response.status(201).json(bodyOf(request, Body));
        });

        app.get('/expeditions', validateQuery(Query), (request, response) => {
          response.json(queryOf(request, Query));
        });

        app.get(
          '/expeditions/:expeditionId',
          validateParams(Params),
          (request, response) => {
            response.json(paramsOf(request, Params));
          },
        );
      }),
    );
  }

  test('hands the handler a value it has already been told is right', async () => {
    const answer = await send(
      await routed(),
      '/expeditions',
      postJson({ name: '  Harbour hunt  ', teamSize: 4 }),
    );

    assert.equal(answer.status, 201);
    assert.deepEqual(answer.body, { name: 'Harbour hunt', teamSize: 4 });
  });

  test('refuses a bad body with the error contract, and does not run the handler', async () => {
    const answer = await send(
      await routed(),
      '/expeditions',
      postJson({ name: '', teamSize: 99, colour: 'red' }),
    );

    assert.equal(answer.status, 422);
    assert.equal(answer.body['error'], 'validation-failed');
    assert.deepEqual(answer.body['details'], [
      { path: 'name', message: 'This cannot be empty.' },
      { path: 'teamSize', message: 'This has to be 8 or less.' },
      { path: 'colour', message: 'This field is not recognised.' },
    ]);
  });

  test('treats a missing body as a missing field, not as a crash', async () => {
    const answer = await send(await routed(), '/expeditions', { method: 'POST' });

    assert.equal(answer.status, 422);
    assert.deepEqual(answer.body['details'], [
      { path: 'name', message: 'This is required.' },
      { path: 'teamSize', message: 'This is required.' },
    ]);
  });

  test('reads the query string, defaults included', async () => {
    const app = await routed();

    assert.deepEqual((await send(app, '/expeditions')).body, { limit: 20 });
    assert.deepEqual((await send(app, '/expeditions?limit=5')).body, { limit: 5 });
  });

  test('marks a query issue with a ? so the path is not ambiguous', async () => {
    const answer = await send(await routed(), '/expeditions?limit=500');

    assert.equal(answer.status, 422);
    assert.deepEqual(answer.body['details'], [
      { path: '?limit', message: 'This has to be 50 or less.' },
    ]);
  });

  test('marks a path parameter issue with a :', async () => {
    const answer = await send(await routed(), '/expeditions/not-an-id');

    assert.equal(answer.status, 422);
    assert.deepEqual(answer.body['details'], [
      { path: ':expeditionId', message: 'This has to be an id.' },
    ]);
  });

  test('lets a good path parameter through', async () => {
    const answer = await send(
      await routed(),
      '/expeditions/3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    );

    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, { expeditionId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' });
  });

  test('tells a developer plainly when they forgot the middleware', async () => {
    const started = await start(
      skeletonApp((app) => {
        app.get('/forgot', (request, response) => {
          response.json(bodyOf(request, Body));
        });
      }, { log: () => {} }),
    );

    const answer = await send(started, '/forgot');
    assert.equal(answer.status, 500);
    assert.equal(answer.body['error'], 'internal-error');
  });
});

/**
 * Driving an Express app over a real socket, for the skeleton's tests.
 *
 * The skeleton's whole job is what happens to a request between the socket
 * and the handler, so these tests send real requests. Nothing here fakes a
 * `Request` object: a fake one would agree with whatever the code did.
 */

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express, { type Express } from 'express';

import { MAX_JSON_BODY } from '../../src/app.ts';
import { errorHandler, notFoundHandler, requestId, type ErrorLogger } from '../../src/http/index.ts';

/** A server listening on a free port, and the base URL to reach it on. */
export interface RunningApp {
  readonly url: string;
  close(): Promise<void>;
}

/** Starts an app on a port the operating system picks. */
export async function listen(app: Express): Promise<RunningApp> {
  const server: Server = await new Promise((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });

  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

/** What a request came back with. */
export interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
  readonly text: string;
}

/** Sends a request and reads the answer, whether or not it is JSON. */
export async function send(
  app: RunningApp,
  path: string,
  init: RequestInit = {},
): Promise<Answer> {
  const response = await fetch(`${app.url}${path}`, init);
  const text = await response.text();

  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    // Left empty. A test that cares asserts on `text`.
  }

  return { status: response.status, headers: response.headers, body, text };
}

/** Sends a JSON body, the way a client would. */
export function postJson(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** A logger that keeps what it was told, so a test can check a fault was reported. */
export function recordingLogger(): {
  readonly lines: { line: string; error: unknown }[];
  log: (line: string, error: unknown) => void;
} {
  const lines: { line: string; error: unknown }[] = [];
  return { lines, log: (line, error) => void lines.push({ line, error }) };
}

/**
 * The same stack `createApp` builds, with routes of the test's own in it.
 *
 * `createApp` takes no routes — every endpoint belongs to a later ticket — so
 * a test that needs to watch the skeleton handle a failing handler has to
 * stand the stack up itself. The order here is the order `createApp` uses,
 * and a test that changed it would be testing something the API does not do.
 */
export function skeletonApp(
  mount: (app: Express) => void,
  options: { readonly log?: ErrorLogger } = {},
): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestId());
  app.use(express.json({ limit: MAX_JSON_BODY }));
  mount(app);
  app.use(notFoundHandler());
  app.use(errorHandler(options.log === undefined ? {} : { log: options.log }));
  return app;
}

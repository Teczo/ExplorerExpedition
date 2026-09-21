/**
 * Turning anything that went wrong into one kind of answer (EXPD-016).
 *
 * Two pieces, and they are the last two things mounted:
 *
 *     app.use(notFoundHandler());
 *     app.use(errorHandler());
 *
 * Nothing between them and the routes is allowed to send an error body of its
 * own invention. A handler that wants to refuse a request throws an
 * `ApiError`; a handler that fails unexpectedly throws whatever it threw, and
 * this turns that into a 500 that says nothing about the inside of the
 * process.
 *
 * Express 5 catches a rejected promise from an `async` handler and passes it
 * here, so there is no `asyncHandler` wrapper in this codebase and no route
 * needs one.
 *
 * What the caller is told, and what the log is told, are different on purpose:
 *
 *   4xx   The message is the point. The caller can fix the request.
 *   5xx   The message is always the same sentence. The stack, the path and
 *         the request id go to the log, and the caller gets the id in the
 *         `X-Request-Id` header so they can quote it.
 */

import type { NextFunction, Request, Response } from 'express';

import { AuthError } from '../auth/errors.ts';
import { ApiError, type ApiErrorBody } from './errors.ts';
import { requestIdOf } from './request-id.ts';

/** Where a server fault is written. */
export type ErrorLogger = (line: string, error: unknown) => void;

/** What `errorHandler` can be given. */
export interface ErrorHandlerOptions {
  /**
   * Where server faults go. Defaults to `console.error`.
   *
   * A test passes its own to keep the output clean, and to check that the
   * fault was reported at all. Application Insights (EXPD-007) reads the
   * process output, so the default is the right one in production.
   */
  readonly log?: ErrorLogger;
}

/**
 * Answers 404 for a request that matched no route.
 *
 * Mounted after every router, so reaching it means nothing claimed the path.
 * Without it Express sends its own HTML page, which is the one error response
 * in the whole API that would not be JSON.
 */
export function notFoundHandler() {
  return (request: Request, response: Response): void => {
    response.status(404).json({
      error: 'not-found',
      message: `There is nothing at ${request.method} ${request.path}.`,
    } satisfies ApiErrorBody);
  };
}

/**
 * The last word on every error.
 *
 * It knows three kinds of thing:
 *
 *   `ApiError`    — raised by a handler or by the validation middleware.
 *   `AuthError`   — raised by EXPD-004. Already this shape; passed through,
 *                   with the `WWW-Authenticate` header a 401 needs.
 *   Anything else — a fault. Logged in full, reported as nothing.
 *
 * The body parser's own failures are read too: a request whose JSON does not
 * parse is the caller's mistake and answers 400, not 500.
 */
export function errorHandler(options: ErrorHandlerOptions = {}) {
  const log = options.log ?? ((line, error) => console.error(line, error));

  return (
    error: unknown,
    request: Request,
    response: Response,
    next: NextFunction,
  ): void => {
    // The response is already going out. Express cannot send a second one, so
    // the only useful thing left is to let it close the connection.
    if (response.headersSent) {
      next(error);
      return;
    }

    const failure = asApiFailure(error);

    if (failure === null) {
      log(`[api] ${describe(request)} failed`, error);
      response.status(500).json({
        error: 'internal-error',
        message: 'Something went wrong on our side.',
      } satisfies ApiErrorBody);
      return;
    }

    if (failure.status === 401) {
      response.setHeader('WWW-Authenticate', 'Bearer');
    }

    // A 5xx the code raised deliberately is still a 5xx, and still worth a log
    // line: `service-unavailable` means something the API depends on is down.
    if (failure.status >= 500) {
      log(`[api] ${describe(request)} answered ${failure.status}`, error);
    }

    response.status(failure.status).json(failure.body);
  };
}

/** What to answer with, or null when this was a fault rather than a refusal. */
function asApiFailure(
  error: unknown,
): { readonly status: number; readonly body: ApiErrorBody } | null {
  if (error instanceof ApiError) {
    return { status: error.status, body: error.toResponseBody() };
  }

  if (error instanceof AuthError) {
    return { status: error.status, body: error.toResponseBody() };
  }

  return bodyParserFailure(error);
}

/**
 * What `express.json()` throws, in this file's vocabulary.
 *
 * body-parser marks its own errors with a `type`, and every one of them is
 * something the caller did: unreadable JSON, a body over the limit, a charset
 * or encoding nothing can read. Left alone they would each be a 500, which
 * would blame the API for a request it was right to refuse.
 */
function bodyParserFailure(
  error: unknown,
): { readonly status: number; readonly body: ApiErrorBody } | null {
  if (typeof error !== 'object' || error === null || !('type' in error)) {
    return null;
  }

  const type = (error as { readonly type?: unknown }).type;

  switch (type) {
    case 'entity.parse.failed':
      return {
        status: 400,
        body: { error: 'bad-request', message: 'That request body is not valid JSON.' },
      };
    case 'entity.too.large':
      return {
        status: 413,
        body: { error: 'payload-too-large', message: 'That request body is too large.' },
      };
    case 'encoding.unsupported':
    case 'charset.unsupported':
      return {
        status: 415,
        body: {
          error: 'unsupported-media-type',
          message: 'This endpoint reads UTF-8 application/json.',
        },
      };
    default:
      return null;
  }
}

/** The request, for a log line. Never the body: it may hold a password. */
function describe(request: Request): string {
  const id = requestIdOf(request);
  return `${request.method} ${request.originalUrl}${id === null ? '' : ` [${id}]`}`;
}

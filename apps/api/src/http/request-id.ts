/**
 * Giving every request a name (EXPD-016).
 *
 * One id follows a request from the front door to the log line, the audit
 * entry (EXPD-006) and the response header. When somebody says "this failed
 * at half past two", the id in the error they were shown is what finds it.
 *
 *     X-Request-Id: 2f7c2f0f-2b6a-4a7f-9b60-1c1b0f2a3f44
 *
 * A caller may send their own — a mobile client that retries wants both
 * attempts under one id, and a proxy in front of the API usually sets one
 * already. What arrives is kept, trimmed to a sane length, so that ids agree
 * across the whole hop. Anything unusable is replaced rather than refused: a
 * request is not worth failing over the name it came with.
 *
 * The header is echoed on every response, not only on errors, so a client can
 * record the id of a call that succeeded and later turned out to be wrong.
 */

import { randomUUID } from 'node:crypto';
import type { Request, RequestHandler } from 'express';

/**
 * The header a request id is read from, and echoed on.
 *
 * `X-Request-Id` rather than the newer `traceparent`, because nothing here
 * speaks W3C trace context and a header that looked like it did would be
 * worse than one that plainly does not.
 */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * The longest request id worth keeping.
 *
 * The same limit the audit log uses, because the id is written into a column
 * there. Anything longer is somebody's mistake, and truncating is kinder than
 * a 400 on a header nobody meant to send.
 */
export const MAX_REQUEST_ID_LENGTH = 200;

declare global {
  namespace Express {
    interface Request {
      /**
       * The id this request is known by, in the log and in the audit entry.
       * Set by `requestId`.
       */
      requestId?: string;
    }
  }
}

/**
 * Reads or mints the request id, and echoes it.
 *
 * Mount it first, before the body parser: a body that is too large to read
 * still produces an error response, and that response should carry an id too.
 */
export function requestId(): RequestHandler {
  return (request, response, next) => {
    const id = incomingRequestId(request) ?? randomUUID();
    request.requestId = id;
    response.setHeader(REQUEST_ID_HEADER, id);
    next();
  };
}

/**
 * The id this request is known by.
 *
 * Falls back to the header for a request that never went through
 * `requestId()` — a unit test standing a router up on its own, for one — and
 * to null when there is neither.
 */
export function requestIdOf(request: Request): string | null {
  return request.requestId ?? incomingRequestId(request);
}

/** The usable id the caller sent, if they sent one. */
function incomingRequestId(request: Request): string | null {
  const header = request.get(REQUEST_ID_HEADER);
  if (header === undefined) {
    return null;
  }

  const trimmed = header.trim().slice(0, MAX_REQUEST_ID_LENGTH);
  return trimmed === '' ? null : trimmed;
}

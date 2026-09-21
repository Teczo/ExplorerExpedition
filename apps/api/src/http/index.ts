/**
 * The REST skeleton (EXPD-016).
 *
 * What every endpoint in every later ticket is built on. It holds no
 * endpoint of its own beyond the health checks, and it knows nothing about
 * expeditions, missions or teams — that is the point of it.
 *
 * Where to look:
 *
 *   `request-id.ts`    Giving every request a name, and echoing it.
 *   `errors.ts`        What the API refuses, and the one body it says so in.
 *   `validation.ts`    Checking what a request sent, before a handler sees it.
 *   `error-handler.ts` Turning anything that went wrong into that one body.
 *   `health.ts`        Whether the process is alive, and whether it is ready.
 *
 * The order the pieces run in is fixed, and `createApp` in `../app.ts` is the
 * one place that says so:
 *
 *   1. `requestId()`           before anything that can fail
 *   2. the health router       before anything that can be slow
 *   3. `express.json()`        with a limit
 *   4. the feature routers     auth (EXPD-004), and everything to come
 *   5. `notFoundHandler()`     nothing claimed the path
 *   6. `errorHandler()`        the last word
 *
 * A route in a later ticket adds itself at step 4 and writes none of the
 * rest. Its handlers throw `ApiError` to refuse a request, put `validateBody`
 * in front of themselves to check one, and let anything unexpected escape —
 * step 6 catches it, logs it with the request id, and tells the caller
 * nothing.
 */

export * from './request-id.ts';
export * from './errors.ts';
export * from './validation.ts';
export * from './error-handler.ts';
export * from './health.ts';

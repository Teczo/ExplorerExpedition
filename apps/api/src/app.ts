/**
 * Building the Express application (EXPD-016).
 *
 * One function, and it is the only place that says what order the pieces run
 * in. Everything it mounts comes from somewhere else: the skeleton from
 * `./http`, the sign-in endpoints from `./auth`, and — in the tickets after
 * this one — a router per feature.
 *
 *     app.use(requestId());            // 1. before anything that can fail
 *     app.use(createHealthRouter());   // 2. before anything that can be slow
 *     app.use(express.json(...));      // 3. with a limit
 *     app.use('/auth', ...);           // 4. the feature routers
 *     app.use('/expeditions', ...);    //    EXPD-017
 *     app.use('/join', ...);           //    EXPD-018
 *     app.use('/sessions', ...);       //    EXPD-018, then EXPD-019
 *     app.use(notFoundHandler());      // 5. nothing claimed the path
 *     app.use(errorHandler());         // 6. the last word
 *
 * Adding an endpoint means adding a router at step 4 and nothing else. The
 * error contract, the request id, the body limit and the 404 are already
 * decided, so no two endpoints can decide them differently.
 */

import express, { type Express, type RequestHandler } from 'express';
import type { OrganisationId } from '@explorer/shared-types';

import { readAuthConfig, type AuthConfig } from './config/auth-config.ts';
import { AuthService, createAuthRouter } from './auth/index.ts';
import { createExpeditionRouter } from './expeditions/index.ts';
import {
  createJoinRouter,
  createParticipationRouter,
} from './participation/index.ts';
import { createSessionRouter } from './sessions/index.ts';
import { globalRepository, tenantRepository, type Queryable } from './db/index.ts';
import {
  createHealthRouter,
  errorHandler,
  notFoundHandler,
  requestId,
  type ErrorLogger,
} from './http/index.ts';
import { AccountRepository } from './repositories/account-repository.ts';
import { DeviceRepository } from './repositories/device-repository.ts';

/**
 * The largest JSON body the API reads.
 *
 * An expedition definition (EXPD-002) is the biggest thing anybody posts, and
 * it is a document, not a file: media goes to Blob Storage through a signed
 * URL (EXPD-021) and never through here. A megabyte is generous for the first
 * and far too small for the second, which is the right way round.
 */
export const MAX_JSON_BODY = '1mb';

/** What `createApp` can be given. */
export interface AppOptions {
  /**
   * The database.
   *
   * Absent in the scaffold, because no driver has been added to the
   * repository yet — that needs a dependency, and no ticket has added one.
   * Without it the app serves the health checks and nothing else, which is
   * what the deploy targets need and all they need.
   *
   * With it, the auth routes are mounted and `/health/ready` reports on the
   * connection. `pg.Pool` satisfies `Queryable` as it is, so the ticket that
   * adds the driver has nothing to write here but the pool.
   */
  readonly db?: Queryable;
  /** Read from the environment when absent. */
  readonly authConfig?: AuthConfig;
  /**
   * Whether to believe `X-Forwarded-For`.
   *
   * Off by default, because a forwarded header is only worth reading when
   * something you control set it. On App Service (EXPD-007) the platform does
   * set it, and `request.ip` is what the audit log records and what the
   * sign-in record keeps, so an instance running behind that proxy should
   * turn this on. Takes anything Express's `trust proxy` setting takes.
   */
  readonly trustProxy?: boolean | number | string;
  /** Where server faults are logged. Defaults to `console.error`. */
  readonly log?: ErrorLogger;
}

/**
 * Builds the Express application.
 *
 * Most routes are added in later tickets. This mounts the health checks, the
 * error contract, and — when there is a database — the sign-in endpoints from
 * EXPD-004.
 */
export function createApp(options: AppOptions = {}): Express {
  const app = express();

  // Says nothing about what the API is built on. Not a security measure on
  // its own, and not pretending to be one; there is simply no reason to send
  // it.
  app.disable('x-powered-by');

  // Express matches `/health/` and `/health` as the same route unless told
  // otherwise, which is what a probe configured by hand needs.
  app.set('strict routing', false);

  if (options.trustProxy !== undefined) {
    app.set('trust proxy', options.trustProxy);
  }

  app.use(requestId());

  // In front of the body parser and the routers: a probe should not queue
  // behind either, and it sends no body.
  app.use(
    createHealthRouter(options.db === undefined ? {} : { db: options.db }),
  );

  app.use(jsonBody());

  if (options.db !== undefined) {
    const db = options.db;
    const authConfig = options.authConfig ?? readAuthConfig();
    const auth = buildAuthService(db, authConfig);

    app.use('/auth', createAuthRouter(auth));
    app.use('/expeditions', createExpeditionRouter({ db, auth }));
    // EXPD-018. `/join` is on its own because it is the one router with no
    // auth in front of it.
    app.use('/join', createJoinRouter({ db, auth, authConfig }));
    // `/sessions` is shared ground: EXPD-018 owns the code, the teams and the
    // students under a run, and EXPD-019 owns the run itself. Express is happy
    // with two routers on one path, and the two never claim the same address —
    // everything EXPD-019 adds is either `/` or a verb under `/:sessionId`.
    app.use('/sessions', createParticipationRouter({ db, auth, authConfig }));
    app.use('/sessions', createSessionRouter({ db, auth }));
  }

  app.use(notFoundHandler());
  app.use(errorHandler(options.log === undefined ? {} : { log: options.log }));

  return app;
}

/**
 * Reads a JSON body, when there is one.
 *
 * A body that is not JSON is not refused here — plenty of requests have no
 * body at all, and a route that wants one says so with `validateBody`, which
 * reports a missing body the same way it reports a missing field. What is
 * refused here is a body too large to read, and one that claims to be JSON
 * and is not; `errorHandler` turns both into the ordinary error contract.
 */
function jsonBody(): RequestHandler {
  return express.json({ limit: MAX_JSON_BODY });
}

/**
 * Wires the auth service to the repository layer.
 *
 * Exported so that a test, a script, or the MCP server (EXPD-074) can build
 * the same service without building an Express app around it.
 */
export function buildAuthService(db: Queryable, config?: AuthConfig): AuthService {
  return new AuthService({
    config: config ?? readAuthConfig(),
    accounts: new AccountRepository(db, globalRepository(db)),
    devicesFor: (organisationId: OrganisationId) =>
      new DeviceRepository(tenantRepository(db, { organisationId })),
  });
}

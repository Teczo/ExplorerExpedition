/**
 * The run lifecycle endpoints (EXPD-019).
 *
 *   POST   /sessions                    schedule a run of a published expedition
 *   GET    /sessions                    this organisation's runs, newest first
 *   GET    /sessions/:id                one run, with its clock as of now
 *   POST   /sessions/:id/start          begin play
 *   POST   /sessions/:id/pause          stop the clock
 *   POST   /sessions/:id/resume         start it again
 *   POST   /sessions/:id/extend         give every team more time
 *   POST   /sessions/:id/end            stop the run for good
 *
 * Every route is the same five-deep stack, in the order EXPD-004 and EXPD-006
 * fixed, and the same one EXPD-017 and EXPD-018 use:
 *
 *     authenticate(auth)              who is calling
 *     requirePermission(...)          may they do this
 *     requireStaff()                  and are they a person, not a phone
 *     tenantScope(db)                 the rows they may touch
 *     auditScope()                    the log, already naming them
 *     validateParams / validateBody   what they sent
 *
 * **Reading and making a run are `session:read` and `session:write`; the five
 * that change a run under way are `session:control`.** That is the split
 * EXPD-004 already wrote into the permission list — `session:write` is
 * "schedule a run, or change one that has not started", `session:control` is
 * "start, pause, resume, end, or override a run in Director Mode" — and this
 * file is the first thing to use it. A facilitator holds all three, because
 * running somebody else's expedition with a class is the whole of that role.
 *
 * `/sessions` is shared ground with EXPD-018, which mounts its own router on
 * the same path for the join code, the teams and the students. Express is
 * happy with two routers on one path, and it keeps each ticket's endpoints in
 * its own file. The two never collide: everything here is either `/` or a
 * verb under `/:sessionId`, and everything there is a noun under it.
 *
 * The five that change a run are `POST` to a verb rather than a `PATCH` of
 * `status`, because they are not the same request with a different value in
 * it. Pausing folds a time into a running total, ending decides between two
 * states by looking at the clock, and extending does not change the status at
 * all. A client that had to know which of those a `PATCH` would do would be
 * holding the rules this ticket exists to own.
 */

import { Router, type Request, type RequestHandler } from 'express';
import {
  isUserPrincipal,
  SESSION_STATUSES,
  type UserPrincipal,
} from '@explorer/shared-types';

import { auditOf, auditScope } from '../audit/context.ts';
import { AuthError } from '../auth/errors.ts';
import {
  authenticate,
  principalOf,
  requirePermission,
  tenantOf,
  tenantScope,
  type AuthService,
} from '../auth/index.ts';
import type { Queryable } from '../db/queryable.ts';
import {
  bodyOf,
  integer,
  object,
  oneOf,
  optional,
  paramsOf,
  queryOf,
  string,
  timestamp,
  validateBody,
  validateParams,
  validateQuery,
  id as uuid,
} from '../http/validation.ts';
import { JoinCodeDirectory } from '../participation/join-code-directory.ts';
import type { RealtimeHub } from '../realtime/hub.ts';
import { sessionChangedNotices, tellRun } from '../realtime/notices.ts';
import {
  MAX_EXTENSION_SECONDS,
  MAX_SESSION_NAME,
  MAX_SESSION_PAGE,
  sessionPage,
  SessionService,
} from './session-service.ts';
import type { SessionView } from './views.ts';

/** The body `POST /sessions` reads. */
const CreateBody = object({
  /** The expedition to run. It has to have a published revision. */
  expeditionId: uuid(),
  /** What the teacher calls it, such as `Year 6 — Tuesday`. */
  name: optional(string({ min: 1, max: MAX_SESSION_NAME })),
  /**
   * When the teacher means to run it.
   *
   * Nothing acts on it — no job opens a lobby and no job starts a run — and
   * a time in the past is not refused, because a teacher filling in last
   * week's lesson is not making a mistake worth an error. What it decides is
   * whether the run opens in `scheduled` or in `lobby`.
   */
  scheduledStartAt: optional(timestamp()),
});

/** The body `POST /sessions/:id/extend` reads. */
const ExtendBody = object({
  seconds: integer({ min: 1, max: MAX_EXTENSION_SECONDS }),
  /** Why, in the teacher's own words. It goes on the audit entry. */
  reason: optional(string({ min: 1, max: 200 })),
});

/** The query `GET /sessions` reads. */
const ListQuery = object({
  status: optional(oneOf(SESSION_STATUSES)),
  expeditionId: optional(uuid()),
  limit: optional(integer({ min: 1, max: MAX_SESSION_PAGE })),
  offset: optional(integer({ min: 0 })),
});

/** The path parameters of every route about one run. */
const SessionParams = object({ sessionId: uuid() });

/** What the router needs. */
export interface SessionRouterOptions {
  readonly db: Queryable;
  readonly auth: AuthService;
  /** Where the phones and Director Mode hear that a run changed (EXPD-023). */
  readonly realtime?: RealtimeHub;
}

/** Builds the run lifecycle routes. */
export function createSessionRouter(options: SessionRouterOptions): Router {
  const router = Router();
  const { db, auth } = options;

  /** Tells everybody watching the run where it stands now, once it is committed. */
  const tell = (request: Request, session: SessionView): SessionView => {
    tellRun(
      options.realtime,
      { organisationId: principalOf(request).organisationId, sessionId: session.id },
      sessionChangedNotices(session),
    );
    return session;
  };

  /** The stack every route here stands on, with the permission it needs. */
  const stack = (
    permission: Parameters<typeof requirePermission>[0],
  ): RequestHandler[] => [
    authenticate(auth),
    requirePermission(permission),
    requireStaff(),
    tenantScope(db),
    auditScope(),
  ];

  router.get(
    '/',
    ...stack('session:read'),
    validateQuery(ListQuery),
    async (request, response) => {
      const query = queryOf(request, ListQuery);
      response.status(200).json(await serviceFor(db, request).list(sessionPage(query)));
    },
  );

  router.post(
    '/',
    ...stack('session:write'),
    validateBody(CreateBody),
    async (request, response) => {
      const body = bodyOf(request, CreateBody);
      const session = await serviceFor(db, request).create({
        expeditionId: body.expeditionId,
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.scheduledStartAt === undefined
          ? {}
          : { scheduledStartAt: body.scheduledStartAt }),
      });

      response.setHeader('Location', `/sessions/${session.id}`);
      response.status(201).json(session);
    },
  );

  router.get(
    '/:sessionId',
    ...stack('session:read'),
    validateParams(SessionParams),
    async (request, response) => {
      const { sessionId } = paramsOf(request, SessionParams);
      response.status(200).json(await serviceFor(db, request).read(sessionId));
    },
  );

  router.post(
    '/:sessionId/start',
    ...stack('session:control'),
    validateParams(SessionParams),
    async (request, response) => {
      const { sessionId } = paramsOf(request, SessionParams);
      response.status(200).json(tell(request, await serviceFor(db, request).start(sessionId)));
    },
  );

  router.post(
    '/:sessionId/pause',
    ...stack('session:control'),
    validateParams(SessionParams),
    async (request, response) => {
      const { sessionId } = paramsOf(request, SessionParams);
      response.status(200).json(tell(request, await serviceFor(db, request).pause(sessionId)));
    },
  );

  router.post(
    '/:sessionId/resume',
    ...stack('session:control'),
    validateParams(SessionParams),
    async (request, response) => {
      const { sessionId } = paramsOf(request, SessionParams);
      response.status(200).json(tell(request, await serviceFor(db, request).resume(sessionId)));
    },
  );

  router.post(
    '/:sessionId/extend',
    ...stack('session:control'),
    validateParams(SessionParams),
    validateBody(ExtendBody),
    async (request, response) => {
      const { sessionId } = paramsOf(request, SessionParams);
      const body = bodyOf(request, ExtendBody);
      response.status(200).json(
        tell(
          request,
          await serviceFor(db, request).extend(sessionId, {
            seconds: body.seconds,
            ...(body.reason === undefined ? {} : { reason: body.reason }),
          }),
        ),
      );
    },
  );

  router.post(
    '/:sessionId/end',
    ...stack('session:control'),
    validateParams(SessionParams),
    async (request, response) => {
      const { sessionId } = paramsOf(request, SessionParams);
      response.status(200).json(tell(request, await serviceFor(db, request).end(sessionId)));
    },
  );

  return router;
}

/**
 * Builds the service for one request.
 *
 * Everything it needs has already been hung off the request by the middleware
 * in front: the repository is pinned to the caller's organisation, the log
 * already names them, and the principal is who the token said. Nothing here
 * reads a header.
 */
function serviceFor(db: Queryable, request: Request): SessionService {
  return new SessionService({
    db,
    tenant: tenantOf(request),
    directory: new JoinCodeDirectory(db),
    audit: auditOf(request),
    principal: staffPrincipalOf(request),
  });
}

/**
 * The caller, as a person with an account.
 *
 * Every run this ticket writes records who made it and who is hosting it, and
 * a student's phone has no user id to record. It holds `session:read`, so
 * without this a phone could list every run in the school and read the clock
 * of one it is not in; what a student's own app should see of its own run is
 * EXPD-040 and EXPD-047.
 */
function staffPrincipalOf(request: Request): UserPrincipal {
  const principal = principalOf(request);
  if (!isUserPrincipal(principal)) {
    throw new AuthError('forbidden', 'a participant device cannot manage a run');
  }
  return principal;
}

/**
 * Refuses a student's phone before a handler runs.
 *
 * `staffPrincipalOf` would refuse it too, but this sits in the stack so that
 * the refusal is visible where the route is declared, next to the permission
 * it goes with — the same reasoning `participation/routes.ts` gives.
 */
function requireStaff(): RequestHandler {
  return (request, _response, next) => {
    if (!isUserPrincipal(principalOf(request))) {
      next(new AuthError('forbidden', 'a participant device cannot manage a run'));
      return;
    }
    next();
  };
}

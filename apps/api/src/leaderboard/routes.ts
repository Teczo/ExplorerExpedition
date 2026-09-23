/**
 * The leaderboard endpoints (EXPD-022).
 *
 *   GET /sessions/:id/leaderboard       one run's teams, placed
 *   GET /expeditions/:id/leaderboard    every finished run of an expedition, placed together
 *
 * Two routers, because they hang off two paths that other tickets already
 * own. Neither claims an address those tickets use: `leaderboard` is a noun
 * nobody else has under `/sessions/:id` or `/expeditions/:id`.
 *
 * **A run's board is `session:read`**, which staff and phones both hold. A
 * phone reads only the board of its own run — another run's is `404` — and
 * only when the revision's `visibility` lets a phone see it now.
 *
 * **An expedition's board is staff only.** It needs `session:read` too, and a
 * phone is refused before the handler runs: it puts other classes side by
 * side, and a phone has no business outside its own run.
 *
 * Every route is the same stack, in the order EXPD-004 and EXPD-006 fixed:
 *
 *     authenticate(auth)              who is calling
 *     requirePermission(...)          may they do this
 *     [requireStaff()]                and, for the expedition's board, a person
 *     tenantScope(db)                 the rows they may touch
 *     auditScope()                    the log, already naming them
 *     validateParams / validateQuery  what they sent
 *
 * Reading a board writes nothing, to the audit log or anywhere else.
 */

import { Router, type Request, type RequestHandler } from 'express';
import { isDevicePrincipal, isUserPrincipal } from '@explorer/shared-types';

import { auditScope } from '../audit/context.ts';
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
  integer,
  object,
  optional,
  paramsOf,
  queryOf,
  validateParams,
  validateQuery,
  id as uuid,
} from '../http/validation.ts';
import {
  DEFAULT_LEADERBOARD_PAGE,
  LeaderboardService,
  MAX_LEADERBOARD_PAGE,
  type LeaderboardViewer,
} from './leaderboard-service.ts';

const SessionParams = object({ sessionId: uuid() });
const ExpeditionParams = object({ expeditionId: uuid() });
const ExpeditionQuery = object({
  limit: optional(integer({ min: 1, max: MAX_LEADERBOARD_PAGE })),
});

/** What the routers need. */
export interface LeaderboardRouterOptions {
  readonly db: Queryable;
  readonly auth: AuthService;
}

/** `GET /sessions/:id/leaderboard`. Mounted at `/sessions`. */
export function createSessionLeaderboardRouter(options: LeaderboardRouterOptions): Router {
  const router = Router();
  const { db, auth } = options;

  router.get(
    '/:sessionId/leaderboard',
    authenticate(auth),
    requirePermission('session:read'),
    tenantScope(db),
    auditScope(),
    validateParams(SessionParams),
    async (request, response) => {
      const { sessionId } = paramsOf(request, SessionParams);
      response
        .status(200)
        .json(await serviceFor(request).sessionBoard(sessionId, viewerOf(request)));
    },
  );

  return router;
}

/** `GET /expeditions/:id/leaderboard`. Mounted at `/expeditions`. */
export function createExpeditionLeaderboardRouter(options: LeaderboardRouterOptions): Router {
  const router = Router();
  const { db, auth } = options;

  router.get(
    '/:expeditionId/leaderboard',
    authenticate(auth),
    requirePermission('session:read'),
    requireStaff(),
    tenantScope(db),
    auditScope(),
    validateParams(ExpeditionParams),
    validateQuery(ExpeditionQuery),
    async (request, response) => {
      const { expeditionId } = paramsOf(request, ExpeditionParams);
      const query = queryOf(request, ExpeditionQuery);
      response.status(200).json(
        await serviceFor(request).expeditionBoard(expeditionId, {
          limit: query.limit ?? DEFAULT_LEADERBOARD_PAGE,
        }),
      );
    },
  );

  return router;
}

function serviceFor(request: Request): LeaderboardService {
  return new LeaderboardService({ tenant: tenantOf(request) });
}

/** Who is reading, as the visibility rules need to know it. */
function viewerOf(request: Request): LeaderboardViewer {
  const principal = principalOf(request);
  return isDevicePrincipal(principal)
    ? { kind: 'device', sessionId: principal.expeditionSessionId }
    : { kind: 'staff' };
}

/** Refuses a student's phone before a handler runs. */
function requireStaff(): RequestHandler {
  return (request, _response, next) => {
    if (!isUserPrincipal(principalOf(request))) {
      next(new AuthError('forbidden', 'a participant device cannot read other runs'));
      return;
    }
    next();
  };
}

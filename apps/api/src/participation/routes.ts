/**
 * The join code, team and participant endpoints (EXPD-018).
 *
 * Two routers, because there are two kinds of caller and they arrive
 * differently.
 *
 * **The student's, at `/join`.** One endpoint, and the only one in the API
 * that runs with no token at all:
 *
 *   POST /join                                     a code and a name in, a device token out
 *
 * It cannot have `authenticate` in front of it, because the whole point of a
 * join code is that a student has no account and nothing to authenticate
 * with. What stands in for it is the code itself: without six right
 * characters the request finds nothing, and what comes back is a token
 * scoped to one participant in one run.
 *
 * **The teacher's, under `/sessions/:sessionId`.** The same five-deep stack
 * EXPD-017 uses, in the order EXPD-004 and EXPD-006 fixed:
 *
 *   GET    /sessions/:id/join-code                 what students should type
 *   POST   /sessions/:id/join-code                 mint a new one, retire the old
 *   GET    /sessions/:id/teams                     the team sheet
 *   POST   /sessions/:id/teams                     add a team
 *   GET    /sessions/:id/participants              everybody in the run
 *   PUT    /sessions/:id/participants/:pid/team    put somebody on a team, with a role
 *   DELETE /sessions/:id/participants/:pid/team    take them off it, leaving them in the run
 *   DELETE /sessions/:id/participants/:pid         take them out of the run
 *
 * Reading the code is `session:read` and minting one is `session:write`,
 * because a code belongs to the run rather than to the students in it.
 * Everything about the students is `participant:read` and
 * `participant:write`, which a facilitator holds: running a class with
 * somebody else's expedition is exactly the job of moving children between
 * teams.
 *
 * `/sessions` is shared ground. EXPD-019 owns the run's own lifecycle and
 * mounts a second router on the same path; Express is happy with that, and it
 * keeps each ticket's endpoints in its own file. The two never claim the same
 * address: everything here is a noun under `/:sessionId`, and everything
 * there is either `/` or a verb under it.
 */

import { Router, type Request, type RequestHandler } from 'express';
import { isUserPrincipal, type OrganisationId } from '@explorer/shared-types';

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
import type { AuthConfig } from '../config/auth-config.ts';
import { tenantRepository, type Queryable } from '../db/index.ts';
import {
  bodyOf,
  boolean,
  object,
  optional,
  paramsOf,
  string,
  validateBody,
  validateParams,
  id as uuid,
} from '../http/validation.ts';
import { DeviceRepository } from '../repositories/device-repository.ts';
import { JoinCodeDirectory } from './join-code-directory.ts';
import {
  JoinService,
  MAX_DISPLAY_NAME,
  MAX_TEAM_NAME,
  ParticipationService,
} from './participation-service.ts';

/**
 * The body `POST /join` reads.
 *
 * The code is checked loosely here — 4 to 20 characters of anything — and
 * read properly by `normaliseJoinCode`, which strips the spaces and hyphens
 * people type and maps the characters the alphabet left out. A code that is
 * still not a code after that is answered `404` with every other wrong code,
 * rather than `422`, so that somebody guessing learns nothing from the
 * difference.
 */
const JoinBody = object({
  joinCode: string({ min: 4, max: 20 }),
  /** What the rest of the team will see. Usually a first name (EXPD-071). */
  displayName: string({ min: 1, max: MAX_DISPLAY_NAME }),
  /** Identifies the phone, so a student who closes the app comes back to it. */
  deviceId: string({ min: 1, max: 200 }),
});

/** The body `POST /sessions/:id/teams` reads. */
const CreateTeamBody = object({ name: string({ min: 1, max: MAX_TEAM_NAME }) });

/**
 * The body `PUT /sessions/:id/participants/:pid/team` reads.
 *
 * A PUT, and it behaves like one: the body is the whole membership, so
 * leaving `role` out means no role and leaving `isLeader` out means not the
 * leader. That is how a role is taken away again, and it is why there is no
 * second endpoint for doing so.
 *
 * `role` is checked against `rules.teams.roles` in the service rather than
 * here, because only the run's own revision knows which names it hands out.
 */
const AssignBody = object({
  teamId: uuid(),
  role: optional(string({ min: 1, max: 60 })),
  isLeader: optional(boolean()),
});

/** The path parameters of every route under one run. */
const SessionParams = object({ sessionId: uuid() });

/** The path parameters of every route about one student. */
const ParticipantParams = object({ sessionId: uuid(), participantId: uuid() });

/** What both routers need. */
export interface ParticipationRouterOptions {
  readonly db: Queryable;
  readonly auth: AuthService;
  /** Read for one number: how long a device token lives. */
  readonly authConfig: AuthConfig;
}

/**
 * Builds the endpoint a student's phone calls.
 *
 * Mounted at `/join`, and deliberately on its own: it is the one router in
 * the API with no auth middleware in front of it, and a reader should be able
 * to see that at a glance rather than by checking each route.
 */
export function createJoinRouter(options: ParticipationRouterOptions): Router {
  const router = Router();

  router.post('/', validateBody(JoinBody), async (request, response) => {
    const body = bodyOf(request, JoinBody);
    const joined = await joinServiceFor(options).join(body);
    response.status(201).json(joined);
  });

  return router;
}

/** Builds the endpoints a teacher's browser calls. */
export function createParticipationRouter(
  options: ParticipationRouterOptions,
): Router {
  const router = Router();
  const { db, auth } = options;

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
    '/:sessionId/join-code',
    ...stack('session:read'),
    validateParams(SessionParams),
    async (request, response) => {
      const { sessionId } = paramsOf(request, SessionParams);
      response.status(200).json(await serviceFor(options, request).readJoinCode(sessionId));
    },
  );

  router.post(
    '/:sessionId/join-code',
    ...stack('session:write'),
    validateParams(SessionParams),
    async (request, response) => {
      const { sessionId } = paramsOf(request, SessionParams);
      response
        .status(200)
        .json(await serviceFor(options, request).reissueJoinCode(sessionId));
    },
  );

  router.get(
    '/:sessionId/teams',
    ...stack('participant:read'),
    validateParams(SessionParams),
    async (request, response) => {
      const { sessionId } = paramsOf(request, SessionParams);
      response.status(200).json(await serviceFor(options, request).listTeams(sessionId));
    },
  );

  router.post(
    '/:sessionId/teams',
    ...stack('participant:write'),
    validateParams(SessionParams),
    validateBody(CreateTeamBody),
    async (request, response) => {
      const { sessionId } = paramsOf(request, SessionParams);
      const body = bodyOf(request, CreateTeamBody);
      const team = await serviceFor(options, request).createTeam(sessionId, body);

      response.setHeader('Location', `/sessions/${sessionId}/teams/${team.id}`);
      response.status(201).json(team);
    },
  );

  router.get(
    '/:sessionId/participants',
    ...stack('participant:read'),
    validateParams(SessionParams),
    async (request, response) => {
      const { sessionId } = paramsOf(request, SessionParams);
      response
        .status(200)
        .json(await serviceFor(options, request).listParticipants(sessionId));
    },
  );

  router.put(
    '/:sessionId/participants/:participantId/team',
    ...stack('participant:write'),
    validateParams(ParticipantParams),
    validateBody(AssignBody),
    async (request, response) => {
      const { sessionId, participantId } = paramsOf(request, ParticipantParams);
      const body = bodyOf(request, AssignBody);
      response
        .status(200)
        .json(
          await serviceFor(options, request).assignToTeam(sessionId, participantId, body),
        );
    },
  );

  router.delete(
    '/:sessionId/participants/:participantId/team',
    ...stack('participant:write'),
    validateParams(ParticipantParams),
    async (request, response) => {
      const { sessionId, participantId } = paramsOf(request, ParticipantParams);
      response
        .status(200)
        .json(await serviceFor(options, request).leaveTeam(sessionId, participantId));
    },
  );

  router.delete(
    '/:sessionId/participants/:participantId',
    ...stack('participant:write'),
    validateParams(ParticipantParams),
    async (request, response) => {
      const { sessionId, participantId } = paramsOf(request, ParticipantParams);
      response
        .status(200)
        .json(
          await serviceFor(options, request).removeParticipant(sessionId, participantId),
        );
    },
  );

  return router;
}

/**
 * Builds the service for one staff request.
 *
 * Everything it needs has already been hung off the request by the middleware
 * in front: the repository is pinned to the caller's organisation, the log
 * already names them, and the principal is who the token said. Nothing here
 * reads a header.
 */
function serviceFor(
  options: ParticipationRouterOptions,
  request: Request,
): ParticipationService {
  const tenant = tenantOf(request);
  return new ParticipationService({
    db: options.db,
    tenant,
    directory: new JoinCodeDirectory(options.db),
    devices: new DeviceRepository(tenant),
    audit: auditOf(request),
  });
}

/**
 * Builds the service the join endpoint uses.
 *
 * It takes a factory for each of the two repositories rather than a built
 * one, because which organisation to build them for is not known until the
 * code has been looked up.
 */
function joinServiceFor(options: ParticipationRouterOptions): JoinService {
  return new JoinService({
    db: options.db,
    directory: new JoinCodeDirectory(options.db),
    tenantFor: (organisationId: OrganisationId) =>
      tenantRepository(options.db, { organisationId }),
    devicesFor: (organisationId: OrganisationId) =>
      new DeviceRepository(tenantRepository(options.db, { organisationId })),
    deviceSeconds: options.authConfig.lifetimes.deviceSeconds,
  });
}

/**
 * Refuses a student's phone, whatever permission it holds.
 *
 * `requirePermission` already turns a device away from the six routes that
 * write, because `student-device` holds neither `participant:write` nor
 * `session:write`. It does hold `participant:read`, so without this the two
 * that read would let a phone draw the whole run's team sheet: every
 * child's name, and which team each of them is on. What a student's own app
 * should see of its own run is EXPD-040 and EXPD-041, and it is not that.
 *
 * It sits in the stack rather than inside a handler so that the refusal is
 * visible where the route is declared, next to the permission it goes with.
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

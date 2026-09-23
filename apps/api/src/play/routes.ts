/**
 * The mission attempt and submission endpoints (EXPD-020).
 *
 *   POST /sessions/:id/missions/:missionId/attempts                  start a try
 *   POST /sessions/:id/missions/:missionId/submissions               hand work in
 *   POST /sessions/:id/missions/:missionId/hints                     open a hint
 *   POST /sessions/:id/teams/:teamId/missions/:missionId/complete    mark waiting work complete, or send it back
 *
 * `:missionId` is the mission's id in the definition document — the
 * `MissionInstance.id` the student app draws its board from — not a database
 * key. A run is pinned to one revision, so inside a run the one names the
 * other.
 *
 * **The first three are a student's phone, and only a phone.** They need
 * `attempt:write`, which only `student-device` holds (EXPD-004), and the team
 * is never in the address: it is the team the phone's student is on, read
 * from the token and the team sheet. A phone cannot play for somebody else's
 * team by writing a different id into a URL, because there is no id to
 * write.
 *
 * **The fourth is a teacher, and only a teacher.** It needs
 * `submission:review`, which creators and facilitators hold, and it names the
 * team, because a teacher marks work for every team in the run.
 *
 * Every route is the same stack, in the order EXPD-004 and EXPD-006 fixed:
 *
 *     authenticate(auth)              who is calling
 *     requirePermission(...)          may they do this
 *     requireDevice() / requireStaff() and are they the right kind of caller
 *     tenantScope(db)                 the rows they may touch
 *     auditScope()                    the log, already naming them
 *     validateParams / validateBody   what they sent
 *
 * `/sessions` is shared ground with EXPD-018 and EXPD-019. Everything here is
 * under a noun neither of them uses (`missions`), or under `teams/:teamId`,
 * which EXPD-018 does not claim below `/teams`.
 */

import { Router, type Request, type RequestHandler } from 'express';
import type { MissionTypeEntry } from '@explorer/engine';
import {
  isDevicePrincipal,
  isUserPrincipal,
  type DevicePrincipal,
  type JsonObject,
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
import { tenantRepository, type Queryable } from '../db/index.ts';
import {
  bodyOf,
  object,
  oneOf,
  optional,
  paramsOf,
  string,
  timestamp,
  unchecked,
  validateBody,
  validateParams,
  withDefault,
  id as uuid,
  type Checker,
} from '../http/validation.ts';
import type { RealtimeHub } from '../realtime/hub.ts';
import { playedNotices, tellRun } from '../realtime/notices.ts';
import { PlayService } from './play-service.ts';
import type { PlayView } from './views.ts';

/** A document id, as EXPD-002 writes them: short, and not a sentence. */
const documentId = (): Checker<string> => string({ min: 1, max: 200 });

/** The path parameters of the three phone routes. */
const MissionParams = object({ sessionId: uuid(), missionId: documentId() });

/** The path parameters of the teacher's route. */
const TeamMissionParams = object({
  sessionId: uuid(),
  teamId: uuid(),
  missionId: documentId(),
});

/** An empty body, or none. Anything in it is a field nobody reads. */
const NoBody = withDefault(object({}), {});

/** A number, whole or not. `integer` would refuse a latitude. */
function number(options: { readonly min: number; readonly max: number }): Checker<number> {
  return {
    check(value, path) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { ok: false, issues: [{ path, message: 'This has to be a number.' }] };
      }
      if (value < options.min || value > options.max) {
        return {
          ok: false,
          issues: [
            { path, message: `This has to be between ${options.min} and ${options.max}.` },
          ],
        };
      }
      return { ok: true, value };
    },
  };
}

/** A JSON object, handed on as it is. Its shape is the mission type's. */
function jsonObject(): Checker<JsonObject> {
  const inner = unchecked();
  return {
    check(value, path) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { ok: false, issues: [{ path, message: 'This has to be an object.' }] };
      }
      const checked = inner.check(value, path);
      return checked.ok ? { ok: true, value: checked.value as JsonObject } : checked;
    },
  };
}

/** The body `POST .../submissions` reads. */
const SubmitBody = object({
  /**
   * The answer. Its shape is the mission type's `submissionSchema`, and the
   * engine checks it against that (EXPD-011); here it only has to be an
   * object.
   */
  payload: jsonObject(),
  /** Where the phone was. Required by a mission that names a place. */
  position: optional(
    object({
      latitude: number({ min: -90, max: 90 }),
      longitude: number({ min: -180, max: 180 }),
      accuracyMetres: optional(number({ min: 0, max: 100_000 })),
      takenAt: optional(timestamp()),
    }),
  ),
  /** When the phone recorded it, if that was not just now (EXPD-048). */
  submittedAt: optional(timestamp()),
});

/** The body `POST .../hints` reads. */
const HintBody = withDefault(object({ hintId: optional(documentId()) }), {
  hintId: undefined,
});

/** The body `POST .../complete` reads. */
const DecisionBody = object({
  /** `approve` marks it complete; `reject` sends it back. */
  decision: oneOf(['approve', 'reject'] as const),
  /** Why, in the teacher's own words. */
  note: optional(string({ min: 1, max: 1000 })),
});

/** What the router needs. */
export interface PlayRouterOptions {
  readonly db: Queryable;
  readonly auth: AuthService;
  /**
   * Mission types that come as code, with a behaviour to judge with.
   *
   * None until the mission type tickets (EXPD-032 to EXPD-039) hand theirs
   * over. Without them a type is its `mission_type` row, and the engine sends
   * its work to a teacher.
   */
  readonly missionTypes?: readonly MissionTypeEntry[];
  /** Where the team's phones and the teacher hear about it (EXPD-023). */
  readonly realtime?: RealtimeHub;
}

/** Builds the mission attempt and submission routes. */
export function createPlayRouter(options: PlayRouterOptions): Router {
  const router = Router();
  const { db, auth } = options;
  const coded = options.missionTypes ?? [];

  /** Tells the run what one change did, once it is committed. */
  const tell = (request: Request, sessionId: string, played: PlayView): void => {
    tellRun(
      options.realtime,
      { organisationId: principalOf(request).organisationId, sessionId },
      playedNotices(played),
    );
  };

  const deviceStack: RequestHandler[] = [
    authenticate(auth),
    requirePermission('attempt:write'),
    requireDevice(),
    tenantScope(db),
    auditScope(),
  ];

  const teacherStack: RequestHandler[] = [
    authenticate(auth),
    requirePermission('submission:review'),
    requireStaff(),
    tenantScope(db),
    auditScope(),
  ];

  router.post(
    '/:sessionId/missions/:missionId/attempts',
    ...deviceStack,
    validateParams(MissionParams),
    validateBody(NoBody),
    async (request, response) => {
      const { sessionId, missionId } = paramsOf(request, MissionParams);
      const played = await serviceFor(db, request, coded).start(
        devicePrincipalOf(request),
        sessionId,
        missionId,
      );
      tell(request, sessionId, played);
      response.status(201).json(played);
    },
  );

  router.post(
    '/:sessionId/missions/:missionId/submissions',
    ...deviceStack,
    validateParams(MissionParams),
    validateBody(SubmitBody),
    async (request, response) => {
      const { sessionId, missionId } = paramsOf(request, MissionParams);
      const body = bodyOf(request, SubmitBody);
      const position = body.position;
      const played = await serviceFor(db, request, coded).submit(
        devicePrincipalOf(request),
        sessionId,
        missionId,
        {
          payload: body.payload,
          ...(position === undefined
            ? {}
            : {
                position: {
                  latitude: position.latitude,
                  longitude: position.longitude,
                  ...(position.accuracyMetres === undefined
                    ? {}
                    : { accuracyMetres: position.accuracyMetres }),
                  ...(position.takenAt === undefined
                    ? {}
                    : { takenAt: position.takenAt.toISOString() }),
                },
              }),
          ...(body.submittedAt === undefined ? {} : { submittedAt: body.submittedAt }),
        },
      );
      tell(request, sessionId, played);
      response.status(201).json(played);
    },
  );

  router.post(
    '/:sessionId/missions/:missionId/hints',
    ...deviceStack,
    validateParams(MissionParams),
    validateBody(HintBody),
    async (request, response) => {
      const { sessionId, missionId } = paramsOf(request, MissionParams);
      const body = bodyOf(request, HintBody);
      const played = await serviceFor(db, request, coded).openHint(
        devicePrincipalOf(request),
        sessionId,
        missionId,
        body.hintId === undefined ? {} : { hintId: body.hintId },
      );
      // A hint opened before costs nothing and changes nothing, so there is
      // nothing to tell anybody.
      if (played.hint?.alreadyOpened !== true) {
        tell(request, sessionId, played);
      }
      response.status(played.hint?.alreadyOpened === true ? 200 : 201).json(played);
    },
  );

  router.post(
    '/:sessionId/teams/:teamId/missions/:missionId/complete',
    ...teacherStack,
    validateParams(TeamMissionParams),
    validateBody(DecisionBody),
    async (request, response) => {
      const { sessionId, teamId, missionId } = paramsOf(request, TeamMissionParams);
      const body = bodyOf(request, DecisionBody);
      const played = await serviceFor(db, request, coded).decide(
        staffPrincipalOf(request),
        sessionId,
        teamId,
        missionId,
        {
          decision: body.decision,
          ...(body.note === undefined ? {} : { note: body.note }),
        },
      );
      tell(request, sessionId, played);
      response.status(200).json(played);
    },
  );

  return router;
}

/** Builds the service for one request, from what the stack hung off it. */
function serviceFor(
  db: Queryable,
  request: Request,
  coded: readonly MissionTypeEntry[],
): PlayService {
  const tenant = tenantOf(request);
  return new PlayService({
    db,
    tenant,
    missionTypes: tenantRepository(db, {
      organisationId: tenant.organisationId,
      includeSharedRows: true,
    }),
    coded,
    audit: auditOf(request),
  });
}

function devicePrincipalOf(request: Request): DevicePrincipal {
  const principal = principalOf(request);
  if (!isDevicePrincipal(principal)) {
    throw new AuthError('forbidden', 'only a student device plays a mission');
  }
  return principal;
}

function staffPrincipalOf(request: Request): UserPrincipal {
  const principal = principalOf(request);
  if (!isUserPrincipal(principal)) {
    throw new AuthError('forbidden', 'a participant device cannot decide on work');
  }
  return principal;
}

/**
 * Refuses anything but a student's phone before a handler runs.
 *
 * Only `student-device` holds `attempt:write` today, so this refuses nobody
 * the permission check has let through. It is here for the day a role is
 * given that permission by mistake: a team's history names who played, and a
 * teacher's account playing for a team would be a history nobody could
 * trust.
 */
function requireDevice(): RequestHandler {
  return (request, _response, next) => {
    if (!isDevicePrincipal(principalOf(request))) {
      next(new AuthError('forbidden', 'only a student device plays a mission'));
      return;
    }
    next();
  };
}

/** Refuses a student's phone before a handler runs. */
function requireStaff(): RequestHandler {
  return (request, _response, next) => {
    if (!isUserPrincipal(principalOf(request))) {
      next(new AuthError('forbidden', 'a participant device cannot decide on work'));
      return;
    }
    next();
  };
}

/**
 * The mission type endpoints the Studio's builder uses (EXPD-025).
 *
 *   GET    /mission-types        every type this organisation can see
 *   GET    /mission-types/:id    one of them
 *   POST   /mission-types        save a new type, as a draft
 *   PUT    /mission-types/:id    save over one of this organisation's drafts
 *   POST   /mission-types/:id/publish   freeze a draft (EXPD-031)
 *   POST   /mission-types/:id/versions  start the next version as a draft (EXPD-031)
 *
 * The same stack every feature router stands on (EXPD-017): authenticate,
 * the permission, the tenant scope, the audit scope, and the body. Reading
 * is `mission-type:read` and saving is `mission-type:write`, the two
 * permissions EXPD-004 set aside for this ticket.
 *
 * The tenant scope includes shared rows, so the platform's own types are
 * read and listed. That widens reads only: `TenantRepository` never writes a
 * row belonging to no organisation (EXPD-004).
 */

import { Router, type Request, type RequestHandler } from 'express';
import { isUserPrincipal, type UserPrincipal } from '@explorer/shared-types';

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
  object,
  paramsOf,
  string,
  validateBody,
  validateParams,
  id as uuid,
} from '../http/validation.ts';
import { authoredMissionType } from './documents.ts';
import { MissionTypeService } from './mission-type-service.ts';

/** The body both saves read. */
const SaveBody = object({ missionType: authoredMissionType() });

/** The body of a new version: the version it will have. */
const NewVersionBody = object({
  version: string({
    min: 1,
    max: 40,
    pattern: /^\d+\.\d+\.\d+$/,
    patternMessage: 'A version is three dot-separated whole numbers, such as "1.1.0".',
  }),
});

/** The path parameters of one type. */
const IdParams = object({ id: uuid() });

/** Builds the mission type routes. */
export function createMissionTypeRouter(options: {
  readonly db: Queryable;
  readonly auth: AuthService;
}): Router {
  const router = Router();
  const { db, auth } = options;

  const stack = (permission: Parameters<typeof requirePermission>[0]): RequestHandler[] => [
    authenticate(auth),
    requirePermission(permission),
    tenantScope(db, { includeSharedRows: true }),
    auditScope(),
  ];

  router.get('/', ...stack('mission-type:read'), async (request, response) => {
    response.status(200).json(await serviceFor(db, request).list());
  });

  router.get(
    '/:id',
    ...stack('mission-type:read'),
    validateParams(IdParams),
    async (request, response) => {
      const { id } = paramsOf(request, IdParams);
      response.status(200).json(await serviceFor(db, request).get(id));
    },
  );

  router.post(
    '/',
    ...stack('mission-type:write'),
    validateBody(SaveBody),
    async (request, response) => {
      const body = bodyOf(request, SaveBody);
      const created = await serviceFor(db, request).create(body.missionType);
      response.setHeader('Location', `/mission-types/${created.id}`);
      response.status(201).json(created);
    },
  );

  router.put(
    '/:id',
    ...stack('mission-type:write'),
    validateParams(IdParams),
    validateBody(SaveBody),
    async (request, response) => {
      const { id } = paramsOf(request, IdParams);
      const body = bodyOf(request, SaveBody);
      response.status(200).json(await serviceFor(db, request).update(id, body.missionType));
    },
  );

  router.post(
    '/:id/publish',
    ...stack('mission-type:write'),
    validateParams(IdParams),
    async (request, response) => {
      const { id } = paramsOf(request, IdParams);
      response.status(200).json(await serviceFor(db, request).publish(id));
    },
  );

  router.post(
    '/:id/versions',
    ...stack('mission-type:write'),
    validateParams(IdParams),
    validateBody(NewVersionBody),
    async (request, response) => {
      const { id } = paramsOf(request, IdParams);
      const body = bodyOf(request, NewVersionBody);
      const created = await serviceFor(db, request).newVersion(id, body.version);
      response.setHeader('Location', `/mission-types/${created.id}`);
      response.status(201).json(created);
    },
  );

  return router;
}

/** Builds the service for one request, from what the middleware hung on it. */
function serviceFor(db: Queryable, request: Request): MissionTypeService {
  return new MissionTypeService({
    db,
    tenant: tenantOf(request),
    audit: auditOf(request),
    principal: staffPrincipalOf(request),
  });
}

/** The caller, as a person with an account. A device holds none of these permissions. */
function staffPrincipalOf(request: Request): UserPrincipal {
  const principal = principalOf(request);
  if (!isUserPrincipal(principal)) {
    throw new AuthError('forbidden', 'a participant device cannot author a mission type');
  }
  return principal;
}

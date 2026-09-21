/**
 * The expedition endpoints (EXPD-017).
 *
 *   POST   /expeditions                       create one, with revision 1 as a draft
 *   GET    /expeditions                       list this organisation's, newest change first
 *   GET    /expeditions/:id                   one expedition, with its draft and published revisions
 *   GET    /expeditions/:id/draft             the document being worked on
 *   PUT    /expeditions/:id/draft             save a document over the draft
 *   POST   /expeditions/:id/publish           freeze the draft
 *   GET    /expeditions/:id/versions          every revision, without the documents
 *   GET    /expeditions/:id/versions/:number  one revision, document and all
 *
 * Every route is the same five-deep stack, in the order EXPD-004 and EXPD-006
 * fixed:
 *
 *     authenticate(auth)              who is calling
 *     requirePermission(...)          may they do this
 *     tenantScope(db)                 the rows they may touch
 *     auditScope()                    the log, already naming them
 *     validateBody / validateQuery    what they sent
 *
 * By the time a handler runs it cannot reach another organisation's rows, and
 * it cannot write an audit entry naming somebody else, because it is never
 * given the chance to say who the caller is or which organisation they are
 * in. None of that is this file's doing — it only stacks the pieces in order.
 *
 * Reading is `expedition:read`, saving is `expedition:write` and publishing
 * is `expedition:publish`, which is a permission of its own because a
 * facilitator may read an expedition somebody else built and may not put it
 * in front of a class as finished.
 *
 * What is deliberately not here: archiving and deleting. `expedition:delete`
 * exists and `expedition.deleted` is in the audit vocabulary, but neither is
 * in this ticket, and an endpoint that retires an expedition has to decide
 * what happens to the runs pointing at it. That is EXPD-019's question.
 */

import { Router, type Request, type RequestHandler } from 'express';
import {
  AUTHORING_SOURCES,
  EXPEDITION_STATUSES,
  isUserPrincipal,
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
  validateBody,
  validateParams,
  validateQuery,
  id as uuid,
} from '../http/validation.ts';
import {
  expeditionPage,
  ExpeditionService,
  MAX_EXPEDITION_PAGE,
} from './expedition-service.ts';
import { expeditionDocument } from './documents.ts';
import { toVersionView } from './views.ts';

/** The body `POST /expeditions` reads. */
const CreateBody = object({
  /**
   * The whole EXPD-002 document.
   *
   * It does not have to be a finished one. A draft may be halfway through,
   * and the answer carries `issues` saying what is still wrong with it. What
   * it does have to have is a name — see `expeditionDocument`.
   */
  definition: expeditionDocument(),
  /** How it came to exist. `studio` when the caller does not say. */
  source: optional(oneOf(AUTHORING_SOURCES)),
});

/** The body `PUT /expeditions/:id/draft` reads. */
const SaveDraftBody = object({ definition: expeditionDocument() });

/** The query `GET /expeditions` reads. */
const ListQuery = object({
  status: optional(oneOf(EXPEDITION_STATUSES)),
  limit: optional(integer({ min: 1, max: MAX_EXPEDITION_PAGE })),
  offset: optional(integer({ min: 0 })),
});

/** The path parameters of every route below `/expeditions/:id`. */
const IdParams = object({ id: uuid() });

/** The path parameters of one revision. */
const VersionParams = object({ id: uuid(), number: integer({ min: 1 }) });

/** Builds the expedition routes. */
export function createExpeditionRouter(options: {
  readonly db: Queryable;
  readonly auth: AuthService;
}): Router {
  const router = Router();
  const { db, auth } = options;

  /** The stack every route here stands on, with the permission it needs. */
  const stack = (permission: Parameters<typeof requirePermission>[0]): RequestHandler[] => [
    authenticate(auth),
    requirePermission(permission),
    tenantScope(db),
    auditScope(),
  ];

  router.get(
    '/',
    ...stack('expedition:read'),
    validateQuery(ListQuery),
    async (request, response) => {
      const query = queryOf(request, ListQuery);
      const page = await serviceFor(db, request).list(expeditionPage(query));
      response.status(200).json(page);
    },
  );

  router.post(
    '/',
    ...stack('expedition:write'),
    validateBody(CreateBody),
    async (request, response) => {
      const body = bodyOf(request, CreateBody);
      const created = await serviceFor(db, request).create({
        definition: body.definition,
        ...(body.source === undefined ? {} : { source: body.source }),
      });

      // The document carries the id as well, but a client that only reads
      // headers should not have to open it to find out where the thing went.
      response.setHeader('Location', `/expeditions/${String(created.definition['id'])}`);
      response.status(201).json(created);
    },
  );

  router.get(
    '/:id',
    ...stack('expedition:read'),
    validateParams(IdParams),
    async (request, response) => {
      const { id } = paramsOf(request, IdParams);
      response.status(200).json(await serviceFor(db, request).read(id));
    },
  );

  router.get(
    '/:id/draft',
    ...stack('expedition:read'),
    validateParams(IdParams),
    async (request, response) => {
      const { id } = paramsOf(request, IdParams);
      response.status(200).json(await serviceFor(db, request).readDraft(id));
    },
  );

  router.put(
    '/:id/draft',
    ...stack('expedition:write'),
    validateParams(IdParams),
    validateBody(SaveDraftBody),
    async (request, response) => {
      const { id } = paramsOf(request, IdParams);
      const { definition } = bodyOf(request, SaveDraftBody);
      response.status(200).json(await serviceFor(db, request).saveDraft(id, definition));
    },
  );

  router.post(
    '/:id/publish',
    ...stack('expedition:publish'),
    validateParams(IdParams),
    async (request, response) => {
      const { id } = paramsOf(request, IdParams);
      response.status(200).json(await serviceFor(db, request).publish(id));
    },
  );

  router.get(
    '/:id/versions',
    ...stack('expedition:read'),
    validateParams(IdParams),
    async (request, response) => {
      const { id } = paramsOf(request, IdParams);
      const versions = await serviceFor(db, request).listVersions(id);
      response.status(200).json({ versions: versions.map(toVersionView) });
    },
  );

  router.get(
    '/:id/versions/:number',
    ...stack('expedition:read'),
    validateParams(VersionParams),
    async (request, response) => {
      const { id, number } = paramsOf(request, VersionParams);
      response.status(200).json(await serviceFor(db, request).readVersion(id, number));
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
function serviceFor(db: Queryable, request: Request): ExpeditionService {
  return new ExpeditionService({
    db,
    tenant: tenantOf(request),
    audit: auditOf(request),
    principal: staffPrincipalOf(request),
  });
}

/**
 * The caller, as a person with an account.
 *
 * A student's phone holds none of these permissions, so it is turned away by
 * `requirePermission` long before here. This is the type system catching up
 * with that: every row this ticket writes records *who* wrote it, and a
 * device has no user id to record.
 */
function staffPrincipalOf(request: Request): UserPrincipal {
  const principal = principalOf(request);
  if (!isUserPrincipal(principal)) {
    throw new AuthError('forbidden', 'a participant device cannot author an expedition');
  }
  return principal;
}

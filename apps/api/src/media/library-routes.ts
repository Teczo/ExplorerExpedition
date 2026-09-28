/**
 * The media library endpoints (EXPD-030), under `/media/library`.
 *
 *   GET    /media/library                 the library, newest first (`?kind=`)
 *   GET    /media/library/:id             one file
 *   POST   /media/library                 a pending file, and the URL to upload it to
 *   POST   /media/library/:id/complete    the upload finished: check it, mark it ready
 *   PATCH  /media/library/:id             rename it, or change its alt text
 *   DELETE /media/library/:id             take it out of the library
 *
 * Reading is `media:read`. Changing is `media:library`, which authors hold
 * and a phone does not: a phone holds `media:write`, and the library is not
 * something a student should be able to change. A file is read back with
 * EXPD-021's `GET /media/:mediaId/download`, the same as any other.
 *
 * The stack is the one every feature router stands on: authenticate, the
 * permission, the tenant scope, the audit scope, and what was sent.
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
  oneOf,
  optional,
  paramsOf,
  queryOf,
  string,
  validateBody,
  validateParams,
  validateQuery,
  id as uuid,
} from '../http/validation.ts';
import { MediaLibraryService } from './library-service.ts';
import type { MediaStorage } from './media-storage.ts';
import { MEDIA_KINDS, assertTypeFitsKind, mediaType } from './routes.ts';

/** Long enough for any file name a person would type. */
export const MAX_NAME_LENGTH = 200;
/** A sentence or two, read aloud in place of the file. */
export const MAX_ALT_TEXT_LENGTH = 1000;

const name = () => string({ min: 1, max: MAX_NAME_LENGTH });
const altText = () => string({ max: MAX_ALT_TEXT_LENGTH });

const ListQuery = object({ kind: optional(oneOf(MEDIA_KINDS)) });
const IdParams = object({ id: uuid() });
const UploadBody = object({
  kind: oneOf(MEDIA_KINDS),
  contentType: mediaType(),
  name: name(),
  altText: optional(altText()),
});
const ChangeBody = object({
  name: optional(name()),
  altText: optional(altText()),
});

/** Builds the library routes. Mounted by `createMediaRouter`. */
export function createMediaLibraryRouter(options: {
  readonly db: Queryable;
  readonly auth: AuthService;
  readonly storage: MediaStorage | undefined;
}): Router {
  const router = Router();
  const { db, auth, storage } = options;

  const stack = (permission: 'media:read' | 'media:library'): RequestHandler[] => [
    authenticate(auth),
    requirePermission(permission),
    tenantScope(db),
    auditScope(),
  ];
  const serviceFor = (request: Request) =>
    new MediaLibraryService({ db, tenant: tenantOf(request), audit: auditOf(request), storage });

  router.get('/', ...stack('media:read'), validateQuery(ListQuery), async (request, response) => {
    const { kind } = queryOf(request, ListQuery);
    response.status(200).json(await serviceFor(request).list(kind));
  });

  router.get('/:id', ...stack('media:read'), validateParams(IdParams), async (request, response) => {
    const { id } = paramsOf(request, IdParams);
    response.status(200).json({ media: await serviceFor(request).get(id) });
  });

  router.post('/', ...stack('media:library'), validateBody(UploadBody), async (request, response) => {
    const body = bodyOf(request, UploadBody);
    assertTypeFitsKind(body.kind, body.contentType);
    const grant = await serviceFor(request).requestUpload(staffPrincipalOf(request), body);
    // The answer carries a signed URL, a credential for as long as it lasts.
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Location', `/media/library/${grant.media.id}`);
    response.status(201).json(grant);
  });

  router.post(
    '/:id/complete',
    ...stack('media:library'),
    validateParams(IdParams),
    async (request, response) => {
      const { id } = paramsOf(request, IdParams);
      response.status(200).json({ media: await serviceFor(request).complete(id) });
    },
  );

  router.patch(
    '/:id',
    ...stack('media:library'),
    validateParams(IdParams),
    validateBody(ChangeBody),
    async (request, response) => {
      const { id } = paramsOf(request, IdParams);
      const body = bodyOf(request, ChangeBody);
      response.status(200).json({ media: await serviceFor(request).update(id, body) });
    },
  );

  router.delete('/:id', ...stack('media:library'), validateParams(IdParams), async (request, response) => {
    const { id } = paramsOf(request, IdParams);
    await serviceFor(request).remove(id);
    response.status(204).end();
  });

  return router;
}

/** The caller, as a person with an account. A phone holds no `media:library`. */
function staffPrincipalOf(request: Request): UserPrincipal {
  const principal = principalOf(request);
  if (!isUserPrincipal(principal)) {
    throw new AuthError('forbidden', 'a participant device cannot change the media library');
  }
  return principal;
}

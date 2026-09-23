/**
 * The signed media URL endpoints (EXPD-021).
 *
 *   POST /media/uploads               a URL to upload one new file to
 *   GET  /media/:mediaId/download     a URL to read one file from
 *
 * **Uploading needs `media:write`**, which staff and student phones both
 * hold (EXPD-004). A phone uploads a photograph and then hands it in by the
 * id this answers with (EXPD-020).
 *
 * **Downloading needs `media:read`**, which a phone does not hold: the
 * student app is given the URLs it needs by the endpoints that draw its
 * screens. A teacher reviewing a photograph is who calls this.
 *
 * Neither URL comes through the API. Both point at Blob Storage, work for
 * one blob, and stop working after a few minutes (`config/storage-config.ts`).
 *
 * Every route is the stack EXPD-004 fixed:
 *
 *     authenticate(auth)              who is calling
 *     requirePermission(...)          may they do this
 *     tenantScope(db)                 the rows they may touch
 *     validateParams / validateBody   what they sent
 *
 * There is no `auditScope()`. Asking for a URL changes nothing a person
 * would later need to answer for: the audit log is for changes (EXPD-006),
 * and the row the upload writes names who uploaded it.
 */

import { Router, type Request } from 'express';

import {
  authenticate,
  principalOf,
  requirePermission,
  tenantOf,
  tenantScope,
  type AuthService,
} from '../auth/index.ts';
import type { Queryable } from '../db/index.ts';
import {
  bodyOf,
  object,
  oneOf,
  paramsOf,
  validateBody,
  validateParams,
  id as uuid,
  type Checker,
} from '../http/validation.ts';
import { ValidationError } from '../http/errors.ts';
import type { MediaKind } from '../repositories/rows.ts';
import { MediaService } from './media-service.ts';
import type { MediaStorage } from './media-storage.ts';

/** The four kinds `media_kind` allows (0001). */
export const MEDIA_KINDS = ['image', 'audio', 'video', 'document'] as const satisfies readonly MediaKind[];

/**
 * The top-level types each kind accepts.
 *
 * A photograph that says it is `application/zip` is not a photograph. This
 * does not look inside the file — nothing here sees it — but it keeps the
 * row's `kind` and the type the file is served with from contradicting each
 * other.
 */
const TYPES_BY_KIND: Readonly<Record<MediaKind, readonly string[]>> = {
  image: ['image'],
  audio: ['audio'],
  video: ['video'],
  document: ['application', 'text'],
};

/** `type/subtype`, as RFC 6838 allows them, and no parameters. */
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/** A media type, lower-cased. */
function mediaType(): Checker<string> {
  return {
    check(value, path) {
      if (typeof value !== 'string' || !MEDIA_TYPE.test(value.trim().toLowerCase())) {
        return {
          ok: false,
          issues: [{ path, message: 'This has to be a media type, such as image/jpeg.' }],
        };
      }
      return { ok: true, value: value.trim().toLowerCase() };
    },
  };
}

/** The body `POST /media/uploads` reads. */
const UploadBody = object({
  kind: oneOf(MEDIA_KINDS),
  contentType: mediaType(),
});

const MediaParams = object({ mediaId: uuid() });

/** What the router needs. */
export interface MediaRouterOptions {
  readonly db: Queryable;
  readonly auth: AuthService;
  /** Absent when storage is not configured. Both routes then answer 503. */
  readonly storage: MediaStorage | undefined;
}

/** Builds the media routes. */
export function createMediaRouter(options: MediaRouterOptions): Router {
  const router = Router();
  const { db, auth, storage } = options;

  // Both answers carry a signed URL, which is a credential for as long as it
  // lasts, so both are sent with `no-store`: nothing between here and the
  // caller should keep a copy.
  router.post(
    '/uploads',
    authenticate(auth),
    requirePermission('media:write'),
    tenantScope(db),
    validateBody(UploadBody),
    async (request, response) => {
      const body = bodyOf(request, UploadBody);
      // A kind and a type that contradict each other are one mistake, found
      // only once both are known to be well formed.
      const topLevel = body.contentType.split('/')[0] ?? '';
      if (!TYPES_BY_KIND[body.kind].includes(topLevel)) {
        throw new ValidationError([
          {
            path: 'contentType',
            message: `A file of kind ${body.kind} has to be ${TYPES_BY_KIND[body.kind]
              .map((type) => `${type}/…`)
              .join(' or ')}.`,
          },
        ]);
      }

      const grant = await serviceFor(request, storage).requestUpload(principalOf(request), body);
      response.setHeader('Cache-Control', 'no-store');
      response.status(201).json(grant);
    },
  );

  router.get(
    '/:mediaId/download',
    authenticate(auth),
    requirePermission('media:read'),
    tenantScope(db),
    validateParams(MediaParams),
    async (request, response) => {
      const { mediaId } = paramsOf(request, MediaParams);
      const grant = await serviceFor(request, storage).requestDownload(mediaId);
      response.setHeader('Cache-Control', 'no-store');
      response.status(200).json(grant);
    },
  );

  return router;
}

function serviceFor(request: Request, storage: MediaStorage | undefined): MediaService {
  return new MediaService({ tenant: tenantOf(request), storage });
}

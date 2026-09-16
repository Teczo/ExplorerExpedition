/**
 * Putting the audit log in front of a route (EXPD-006).
 *
 * The same arrangement as `../auth/middleware.ts`, and it sits directly after
 * it:
 *
 *     router.post(
 *       '/expeditions/:id/publish',
 *       authenticate(service),
 *       requirePermission('expedition:publish'),
 *       tenantScope(db),
 *       auditScope(),
 *       handler,
 *     );
 *
 * By the time the handler runs, `auditOf(request)` gives it a log already
 * pinned to the caller's organisation and already knowing who is calling,
 * from where, and under which request id. A handler cannot write an entry
 * naming somebody else, because it is never given the chance to say who the
 * actor is.
 *
 * `auditScope` has to come after `tenantScope`, because it is built on the
 * repository that one makes. Standing it up on its own would mean a second
 * place that decides which organisation a row belongs to, and there is only
 * ever one.
 */

import type { Request, RequestHandler } from 'express';
import type { AuditActor, Principal } from '@explorer/shared-types';

import { AuthError } from '../auth/errors.ts';
import { tenantOf } from '../auth/middleware.ts';
import { AuditLog, type AuditContext } from './audit-log.ts';

declare global {
  namespace Express {
    interface Request {
      /**
       * The log the handler appends to, pinned to the principal's
       * organisation and naming the principal. Set by `auditScope`.
       */
      audit?: AuditLog;
    }
  }
}

/**
 * The header a request id is read from.
 *
 * A proxy or a client sets it; nothing here mints one, because generating and
 * echoing a request id belongs to the REST skeleton in EXPD-016. Until that
 * lands, entries written by a request that carried no header simply have no
 * `request_id`, and everything else about them is unaffected.
 */
export const REQUEST_ID_HEADER = 'x-request-id';

/** The longest request id worth storing. Anything longer is somebody's mistake. */
const MAX_REQUEST_ID_LENGTH = 200;

/**
 * Who a principal is, in the log's vocabulary.
 *
 * A student's phone is recorded as the participant it belongs to, not as the
 * device: the entry is about a person doing something, and the device is one
 * of several a student might use.
 *
 * `label` is only ever read for a staff account. A participant is labelled by
 * id whatever is passed here, because they are a child (EXPD-071).
 */
export function auditActorOf(principal: Principal, label?: string): AuditActor {
  if (principal.kind === 'user') {
    return {
      kind: 'user',
      userId: principal.userId,
      ...(label === undefined ? {} : { label }),
    };
  }
  return { kind: 'participant', participantId: principal.participantId };
}

/** The platform acting on its own, such as the scoring engine (EXPD-012). */
export function systemActor(label: string): AuditActor {
  return { kind: 'system', label };
}

/** Something outside the platform, such as a Stripe webhook (EXPD-068). */
export function serviceActor(label: string): AuditActor {
  return { kind: 'service', label };
}

/**
 * What the log should record about where a request came from.
 *
 * `request.ip` is Express's own answer, which honours `trust proxy`, so this
 * does not read `X-Forwarded-For` itself and cannot be fooled by a header a
 * caller invented when the app is configured not to trust one.
 */
export function auditContextOf(request: Request, actor: AuditActor): AuditContext {
  return {
    actor,
    ipAddress: request.ip ?? null,
    userAgent: request.get('user-agent') ?? null,
    requestId: requestIdOf(request),
  };
}

/** The request id this request carries, or null. */
export function requestIdOf(request: Request): string | null {
  const header = request.get(REQUEST_ID_HEADER);
  if (header === undefined || header.trim() === '') {
    return null;
  }
  return header.slice(0, MAX_REQUEST_ID_LENGTH);
}

/**
 * Builds the log the handler appends to.
 *
 * Runs after `authenticate` and `tenantScope`. Without a principal there is
 * nobody to name, and an entry that named nobody would be worse than no
 * entry, so this refuses the request rather than writing one.
 */
export function auditScope(): RequestHandler {
  return (request, response, next) => {
    const principal = request.principal;
    if (principal === undefined) {
      const error = new AuthError('no-credentials');
      response.status(error.status).json(error.toResponseBody());
      return;
    }

    request.audit = new AuditLog(
      tenantOf(request),
      auditContextOf(request, auditActorOf(principal)),
    );
    next();
  };
}

/** Reads the log off a request, and throws if no `auditScope` ran in front. */
export function auditOf(request: Request): AuditLog {
  const audit = request.audit;
  if (audit === undefined) {
    throw new Error(
      'This handler read request.audit, but no auditScope() runs in front of it.',
    );
  }
  return audit;
}

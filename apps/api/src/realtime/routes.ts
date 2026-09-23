/**
 * The realtime endpoints (EXPD-023).
 *
 *   GET  /sessions/:id/events           a run's stream, as Server-Sent Events
 *   POST /sessions/:id/announcements    a teacher says something to the run, or one team
 *
 * **The stream is `session:read`**, which staff and phones both hold. A phone
 * hears only its own run — another run's stream is `404` — and is refused
 * once its student has been taken out of it. What each viewer hears on the
 * stream is decided by the hub (`hub.ts`), not by the client.
 *
 * **An announcement is `session:control`**, the permission that already says
 * "change a run under way in Director Mode" (EXPD-004), and staff only. It
 * changes no record: it is a sentence on the channel and nothing else, so
 * it writes no audit entry.
 *
 * `/sessions` is shared ground. `events` and `announcements` are nouns no
 * router mounted there claims.
 */

import { Router, type Request, type RequestHandler } from 'express';
import { isDevicePrincipal, isFinalSessionStatus, isUserPrincipal } from '@explorer/shared-types';

import { AuthError } from '../auth/errors.ts';
import {
  authenticate,
  principalOf,
  requirePermission,
  tenantOf,
  tenantScope,
  type AuthService,
} from '../auth/index.ts';
import { bearerToken } from '../auth/tokens.ts';
import type { Queryable } from '../db/queryable.ts';
import { ApiError, notFound } from '../http/errors.ts';
import {
  bodyOf,
  object,
  optional,
  paramsOf,
  string,
  validateBody,
  validateParams,
  id as uuid,
} from '../http/validation.ts';
import type {
  ExpeditionSessionRow,
  ParticipantRow,
  TeamMemberRow,
  TeamRow,
} from '../repositories/rows.ts';
import type { RealtimeHub, Viewer } from './hub.ts';
import { announcementNotices } from './notices.ts';
import { openStream, tokenExpiresAt } from './stream.ts';

/** The longest announcement. A sentence or two for a phone screen, not a letter. */
export const MAX_ANNOUNCEMENT = 500;

const SessionParams = object({ sessionId: uuid() });

const AnnouncementBody = object({
  message: string({ min: 1, max: MAX_ANNOUNCEMENT }),
  /** Send it to one team only. Everybody in the run when absent. */
  teamId: optional(uuid()),
});

/** What the router needs. */
export interface RealtimeRouterOptions {
  readonly db: Queryable;
  readonly auth: AuthService;
  readonly hub: RealtimeHub;
  /** How often a stream sends a heartbeat. Tests shorten it. */
  readonly heartbeatSeconds?: number;
  readonly log?: (message: string, error?: unknown) => void;
}

/** Builds the realtime routes. Mounted at `/sessions`. */
export function createRealtimeRouter(options: RealtimeRouterOptions): Router {
  const router = Router();
  const { db, auth, hub } = options;

  router.get(
    '/:sessionId/events',
    authenticate(auth),
    requirePermission('session:read'),
    tenantScope(db),
    validateParams(SessionParams),
    async (request, response) => {
      const { sessionId } = paramsOf(request, SessionParams);
      const principal = principalOf(request);
      const { session, viewer } = await resolveViewer(request, sessionId);

      await openStream(response, {
        hub,
        target: { organisationId: principal.organisationId, sessionId: session.id },
        viewer,
        sessionStatus: session.status,
        expiresAt: tokenExpiry(request),
        ...(options.heartbeatSeconds === undefined
          ? {}
          : { heartbeatSeconds: options.heartbeatSeconds }),
        ...(options.log === undefined ? {} : { log: options.log }),
      });
    },
  );

  router.post(
    '/:sessionId/announcements',
    authenticate(auth),
    requirePermission('session:control'),
    requireStaff(),
    tenantScope(db),
    validateParams(SessionParams),
    validateBody(AnnouncementBody),
    async (request, response) => {
      const { sessionId } = paramsOf(request, SessionParams);
      const body = bodyOf(request, AnnouncementBody);
      const tenant = tenantOf(request);

      const session = await tenant.findById<ExpeditionSessionRow>('expedition_session', sessionId);
      if (session === null) {
        throw notFound('run');
      }
      if (isFinalSessionStatus(session.status)) {
        throw new ApiError('conflict', {
          message: 'That run is over. Nobody is listening to it any more.',
          detail: `run ${session.id} is ${session.status}`,
        });
      }
      const teamId = body.teamId ?? null;
      if (teamId !== null) {
        const team = await tenant.findOne<TeamRow>('team', {
          where: { id: teamId, expedition_session_id: session.id },
        });
        if (team === null) {
          throw notFound('team');
        }
      }

      const [sent] = await hub.publish(
        { organisationId: principalOf(request).organisationId, sessionId: session.id },
        announcementNotices(body.message, teamId),
      );
      if (sent === undefined) {
        throw new ApiError('service-unavailable', {
          message: 'The announcement could not be sent. Try again.',
          detail: `publishing to run ${session.id} failed`,
        });
      }
      response.status(202).json(sent);
    },
  );

  return router;
}

/**
 * Works out who is opening a stream, and checks they may.
 *
 * Staff may watch any run in their organisation. A phone may watch its own
 * run while its student is still in it, and hears its team's events from
 * the team it is on now.
 */
async function resolveViewer(
  request: Request,
  sessionId: string,
): Promise<{ session: ExpeditionSessionRow; viewer: Viewer }> {
  const principal = principalOf(request);
  const tenant = tenantOf(request);

  // A phone belongs to one run. Another run's id is not found, for the reason
  // EXPD-017 gives for answering 404 rather than 403.
  if (isDevicePrincipal(principal) && principal.expeditionSessionId !== sessionId) {
    throw notFound('run');
  }
  const session = await tenant.findById<ExpeditionSessionRow>('expedition_session', sessionId);
  if (session === null) {
    throw notFound('run');
  }
  if (!isDevicePrincipal(principal)) {
    return { session, viewer: { kind: 'staff' } };
  }

  const participant = await tenant.findOne<ParticipantRow>('participant', {
    where: { id: principal.participantId, expedition_session_id: session.id },
  });
  if (participant === null || participant.status === 'removed' || participant.status === 'left') {
    throw notFound('run');
  }
  const membership = await tenant.findOne<TeamMemberRow>('team_member', {
    where: { participant_id: participant.id, left_at: null },
  });
  return {
    session,
    viewer: { kind: 'device', participantId: participant.id, teamId: membership?.team_id ?? null },
  };
}

/** When the token this request came with runs out. */
function tokenExpiry(request: Request): Date | undefined {
  return tokenExpiresAt(bearerToken(request.headers.authorization));
}

/** Refuses a student's phone before a handler runs. */
function requireStaff(): RequestHandler {
  return (request, _response, next) => {
    if (!isUserPrincipal(principalOf(request))) {
      next(new AuthError('forbidden', 'a participant device cannot make announcements'));
      return;
    }
    next();
  };
}

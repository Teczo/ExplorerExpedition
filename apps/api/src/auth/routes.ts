/**
 * The sign-in endpoints (EXPD-004).
 *
 * Deliberately few. EXPD-016 owns the REST API skeleton and every other
 * ticket owns its own endpoints; these are only the ones without which
 * nothing else can be reached.
 *
 *   POST /auth/sign-in                    email and password in, refresh token out
 *   POST /auth/token                      refresh token plus an organisation in,
 *                                         access token out
 *   POST /auth/refresh                    refresh token in, a new one out
 *   POST /auth/sign-out                   end the sign-in
 *   POST /auth/device/token               device token in, access token out
 *   GET  /auth/me                         who the access token says I am
 *
 * There is no sign-up route, and no join route. Creating an organisation and
 * its first account is EXPD-049 and EXPD-070; turning a join code into a
 * participant is EXPD-018. Both of those then call `AuthService` for the
 * credential half.
 */

import { Router, type Request, type Response } from 'express';
import { permissionsOf, type OrganisationId } from '@explorer/shared-types';

import { AuthError } from './errors.ts';
import type { AuthService } from './auth-service.ts';
import { authenticate, principalOf } from './middleware.ts';

/** Builds the auth routes. */
export function createAuthRouter(service: AuthService): Router {
  const router = Router();

  /**
   * Signs in with an email and a password.
   *
   * Answers with a refresh token and the organisations the person may act
   * for. An access token comes back too when there is only one of them, so
   * the common case is a single round trip.
   */
  router.post('/sign-in', async (request, response) => {
    const body = asObject(request.body);
    const email = asString(body['email']);
    const password = asString(body['password']);

    if (email === null || password === null) {
      respondWithError(
        response,
        new AuthError('bad-credentials', 'sign-in needs an email and a password'),
      );
      return;
    }

    try {
      const result = await service.signIn(email, password, originOf(request));
      response.status(200).json({
        userId: result.userId,
        displayName: result.displayName,
        isPlatformAdmin: result.isPlatformAdmin,
        refreshToken: result.refreshToken,
        refreshTokenExpiresAt: result.refreshTokenExpiresAt.toISOString(),
        organisations: result.organisations,
        accessToken:
          result.accessToken === null ? null : describeToken(result.accessToken),
      });
    } catch (error) {
      respondWithError(response, error);
    }
  });

  /**
   * Asks for an access token for one organisation.
   *
   * This is the org-scoping step. The membership is checked again here, so a
   * membership revoked since the sign-in stops working now rather than
   * whenever the refresh token next expires.
   */
  router.post('/token', async (request, response) => {
    const body = asObject(request.body);
    const refreshToken = asString(body['refreshToken']);
    const organisationId = asString(body['organisationId']);

    if (refreshToken === null || organisationId === null) {
      respondWithError(
        response,
        new AuthError('bad-token', 'a refresh token and an organisation are needed'),
      );
      return;
    }

    try {
      const token = await service.accessTokenFor(
        refreshToken,
        organisationId as OrganisationId,
      );
      response.status(200).json(describeToken(token));
    } catch (error) {
      respondWithError(response, error);
    }
  });

  /**
   * Exchanges a refresh token for a new one.
   *
   * The old one stops working immediately. A client that loses the answer to
   * this call has to sign in again, which is the price of catching a stolen
   * token that gets used twice.
   */
  router.post('/refresh', async (request, response) => {
    const refreshToken = asString(asObject(request.body)['refreshToken']);
    if (refreshToken === null) {
      respondWithError(response, new AuthError('bad-token', 'no refresh token sent'));
      return;
    }

    try {
      const result = await service.refresh(refreshToken, originOf(request));
      response.status(200).json({
        userId: result.userId,
        refreshToken: result.refreshToken,
        refreshTokenExpiresAt: result.refreshTokenExpiresAt.toISOString(),
        organisations: result.organisations,
      });
    } catch (error) {
      respondWithError(response, error);
    }
  });

  /**
   * Signs out.
   *
   * Always answers 204, whether or not the token was one we knew. A different
   * answer would say whether it was real.
   */
  router.post('/sign-out', async (request, response) => {
    const refreshToken = asString(asObject(request.body)['refreshToken']);
    if (refreshToken !== null) {
      await service.signOut(refreshToken);
    }
    response.status(204).end();
  });

  /**
   * Turns a student's device token into a short-lived access token.
   *
   * The organisation is sent alongside because a device token is looked up
   * inside one organisation, never across all of them — the same rule as every
   * other read. The student app already knows its organisation: it was told
   * when it joined (EXPD-018).
   */
  router.post('/device/token', async (request, response) => {
    const body = asObject(request.body);
    const organisationId = asString(body['organisationId']);
    const deviceToken = asString(body['deviceToken']);

    if (organisationId === null || deviceToken === null) {
      respondWithError(
        response,
        new AuthError('bad-token', 'an organisation and a device token are needed'),
      );
      return;
    }

    try {
      const token = await service.deviceAccessToken(
        organisationId as OrganisationId,
        deviceToken,
      );
      response.status(200).json({
        accessToken: token.token,
        expiresAt: token.expiresAt.toISOString(),
        organisationId: token.organisationId,
        participantId: token.participantId,
        expeditionSessionId: token.expeditionSessionId,
      });
    } catch (error) {
      respondWithError(response, error);
    }
  });

  /**
   * Says who the access token belongs to, and what it may do.
   *
   * A client uses it to decide which buttons to draw. It is never the check
   * that matters — that always happens on the server, on the request that
   * does the thing.
   */
  router.get('/me', authenticate(service), (request, response) => {
    const principal = principalOf(request);
    response.status(200).json({
      principal,
      permissions: permissionsOf(principal),
    });
  });

  return router;
}

function describeToken(token: {
  token: string;
  expiresAt: Date;
  organisationId: string;
  orgRole: string;
}): Record<string, unknown> {
  return {
    accessToken: token.token,
    expiresAt: token.expiresAt.toISOString(),
    organisationId: token.organisationId,
    orgRole: token.orgRole,
  };
}

function respondWithError(response: Response, error: unknown): void {
  if (error instanceof AuthError) {
    if (error.status === 401) {
      response.setHeader('WWW-Authenticate', 'Bearer');
    }
    response.status(error.status).json(error.toResponseBody());
    return;
  }
  throw error;
}

/** Where the request came from, for the sign-in record. */
function originOf(request: Request): { userAgent: string | null; ipAddress: string | null } {
  return {
    userAgent: request.headers['user-agent'] ?? null,
    ipAddress: request.ip ?? null,
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

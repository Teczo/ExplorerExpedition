/**
 * Putting auth in front of a route (EXPD-004).
 *
 * Three pieces of middleware, meant to be stacked:
 *
 *     router.get(
 *       '/expeditions',
 *       authenticate(service),
 *       requirePermission('expedition:read'),
 *       handler,
 *     );
 *
 * `authenticate` reads the token and hangs a principal off the request.
 * `requirePermission` checks what that principal may do. `tenantScope` builds
 * the repository the handler reads rows through, already pinned to the
 * principal's organisation.
 *
 * A handler that reaches the third one cannot read another organisation's
 * rows even if it tries, because the repository it is given has no way to ask
 * for them. That is the arrangement: the token fixes the organisation, and
 * the repository layer enforces it.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { can, type Permission, type Principal } from '@explorer/shared-types';

import type { Queryable } from '../db/queryable.ts';
import { tenantRepository, type TenantRepository } from '../db/tenant-repository.ts';
import type { AuthService } from './auth-service.ts';
import { AuthError } from './errors.ts';
import { bearerToken } from './tokens.ts';

declare global {
  namespace Express {
    interface Request {
      /**
       * Who is making this request. Set by `authenticate`, and absent on a
       * route that does not use it.
       */
      principal?: Principal;
      /**
       * The repository the handler reads rows through, pinned to the
       * principal's organisation. Set by `tenantScope`.
       */
      tenant?: TenantRepository;
    }
  }
}

/**
 * Reads the bearer token and works out who is calling.
 *
 * Both kinds of caller arrive the same way. Which kind is decided by the
 * token's own audience claim and not by the path, so a device token presented
 * to a staff route fails the signature check for the staff audience rather
 * than being half accepted.
 */
export function authenticate(service: AuthService): RequestHandler {
  return (request, response, next) => {
    const token = bearerToken(request.headers.authorization);
    if (token === null) {
      sendAuthError(response, new AuthError('no-credentials'));
      return;
    }

    try {
      request.principal = readPrincipal(service, token);
      next();
    } catch (error) {
      forward(error, response, next);
    }
  };
}

/**
 * Like `authenticate`, but lets a request with no token through.
 *
 * For the handful of routes that answer differently to somebody signed in —
 * not for routes that are open to everybody, which should not have auth
 * middleware at all. A bad token is still refused: an unreadable token is a
 * mistake worth reporting, not an anonymous request.
 */
export function authenticateOptional(service: AuthService): RequestHandler {
  return (request, response, next) => {
    const token = bearerToken(request.headers.authorization);
    if (token === null) {
      next();
      return;
    }

    try {
      request.principal = readPrincipal(service, token);
      next();
    } catch (error) {
      forward(error, response, next);
    }
  };
}

/** Refuses the request unless the principal holds the permission. */
export function requirePermission(permission: Permission): RequestHandler {
  return (request, response, next) => {
    const principal = request.principal;
    if (principal === undefined) {
      sendAuthError(response, new AuthError('no-credentials'));
      return;
    }
    if (!can(principal, permission)) {
      sendAuthError(
        response,
        new AuthError('forbidden', `principal lacks ${permission}`),
      );
      return;
    }
    next();
  };
}

/** Refuses the request unless the principal holds every one of the permissions. */
export function requireAllPermissions(
  ...permissions: readonly Permission[]
): RequestHandler {
  return (request, response, next) => {
    const principal = request.principal;
    if (principal === undefined) {
      sendAuthError(response, new AuthError('no-credentials'));
      return;
    }

    const missing = permissions.filter((permission) => !can(principal, permission));
    if (missing.length > 0) {
      sendAuthError(
        response,
        new AuthError('forbidden', `principal lacks ${missing.join(', ')}`),
      );
      return;
    }
    next();
  };
}

/**
 * Builds the repository the handler reads rows through.
 *
 * `includeSharedRows` widens reads to the platform-wide mission types,
 * templates and badges. A route that lists what an author may choose from
 * turns it on; everything else leaves it off.
 */
export function tenantScope(
  db: Queryable,
  options: { readonly includeSharedRows?: boolean } = {},
): RequestHandler {
  return (request, response, next) => {
    const principal = request.principal;
    if (principal === undefined) {
      sendAuthError(response, new AuthError('no-credentials'));
      return;
    }

    request.tenant = tenantRepository(db, {
      organisationId: principal.organisationId,
      ...(options.includeSharedRows === undefined
        ? {}
        : { includeSharedRows: options.includeSharedRows }),
    });
    next();
  };
}

/**
 * Reads the principal off a request, and throws if it is not there.
 *
 * For a handler that has `authenticate` in front of it: the type says the
 * principal is optional, because Express has one `Request` type for every
 * route, and this turns that back into a certainty in one place.
 */
export function principalOf(request: Request): Principal {
  const principal = request.principal;
  if (principal === undefined) {
    throw new Error(
      'This handler read request.principal, but no authenticate() runs in front of it.',
    );
  }
  return principal;
}

/** Reads the tenant repository off a request, and throws if it is not there. */
export function tenantOf(request: Request): TenantRepository {
  const tenant = request.tenant;
  if (tenant === undefined) {
    throw new Error(
      'This handler read request.tenant, but no tenantScope() runs in front of it.',
    );
  }
  return tenant;
}

/**
 * Turns an `AuthError` thrown by a handler into a response.
 *
 * Mounted after the routes. Anything that is not an `AuthError` is passed on.
 *
 * `createApp` does not use this: `errorHandler` from `../http` (EXPD-016)
 * knows `AuthError` already and answers in the same shape, and one error
 * handler is better than two that have to be kept in step. It stays exported
 * for a router stood up on its own, and for the tests that do exactly that.
 */
export function authErrorHandler(): (
  error: unknown,
  request: Request,
  response: Response,
  next: NextFunction,
) => void {
  return (error, _request, response, next) => {
    if (error instanceof AuthError) {
      sendAuthError(response, error);
      return;
    }
    next(error);
  };
}

/**
 * Works out which kind of token was presented.
 *
 * A token is checked as a staff token first, and as a device token only if
 * that fails. Neither check can accept the other's tokens: the audience is
 * inside the signature, so this is two full checks rather than a guess.
 */
function readPrincipal(service: AuthService, token: string): Principal {
  try {
    return service.authenticateUser(token);
  } catch (error) {
    if (!(error instanceof AuthError)) {
      throw error;
    }
    return service.authenticateDevice(token);
  }
}

function sendAuthError(response: Response, error: AuthError): void {
  // Tells a client the request needed credentials it did not supply, which is
  // what the status on its own does not say.
  if (error.status === 401) {
    response.setHeader('WWW-Authenticate', 'Bearer');
  }
  response.status(error.status).json(error.toResponseBody());
}

function forward(error: unknown, response: Response, next: NextFunction): void {
  if (error instanceof AuthError) {
    sendAuthError(response, error);
    return;
  }
  next(error);
}

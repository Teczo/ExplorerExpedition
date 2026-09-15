/**
 * Auth and organisation tenancy — the API half (EXPD-004).
 *
 * The shared half — roles, permissions, principals — is in
 * `@explorer/shared-types`, because the Studio and the student app need it
 * too. Everything here hashes, signs, reads a row or sits in front of a
 * route, so it stays on the server.
 *
 * Where to look:
 *
 *   `password.ts`      Hashing and checking passwords, on scrypt.
 *   `tokens.ts`        Signing access tokens, and minting refresh tokens.
 *   `auth-service.ts`  Signing in, staying signed in, signing out.
 *   `middleware.ts`    Putting auth in front of a route.
 *   `routes.ts`        The sign-in endpoints.
 *   `errors.ts`        What it refuses, and what the caller is told.
 */

export * from './errors.ts';
export * from './password.ts';
export * from './tokens.ts';
export * from './auth-service.ts';
export * from './middleware.ts';
export * from './routes.ts';

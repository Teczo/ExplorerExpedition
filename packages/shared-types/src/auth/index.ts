/**
 * Auth and organisation tenancy (EXPD-004).
 *
 * The shared half: the vocabulary of roles, permissions and principals that
 * the API, the Studio, the creator web app and the student app all use.
 * Nothing here hashes, signs or reads a database. That is `apps/api/src/auth`.
 *
 * Where to look:
 *
 *   `roles.ts`        The roles, and how the stored membership roles map onto
 *                     them.
 *   `permissions.ts`  What each role may do.
 *   `principal.ts`    Who is making a request, once the token has been checked.
 *   `access.ts`       Asking whether they may do a thing.
 */

export * from './roles.ts';
export * from './permissions.ts';
export * from './principal.ts';
export * from './access.ts';

/**
 * The audit log — the API half (EXPD-006).
 *
 * The shared half — what an entry says, and the closed list of things it can
 * say happened — is in `@explorer/shared-types`, because the admin portal and
 * the Studio read entries too. Everything here writes a row or decides what
 * may go into one, so it stays on the server.
 *
 * The rule the whole thing rests on: an entry is appended and never touched
 * again. Migration 0003 makes PostgreSQL refuse an UPDATE, a DELETE and a
 * TRUNCATE on the table, and `TenantRepository` refuses the first two before
 * a statement is built. Nothing in this folder offers a way round either,
 * because there is nothing a way round would be for.
 *
 * Where to look:
 *
 *   `redact.ts`     How much of a row goes in, and what has to stay out.
 *   `audit-log.ts`  Appending an entry, and reading entries back.
 *   `context.ts`    Putting the log in front of a route.
 */

export * from './redact.ts';
export * from './audit-log.ts';
export * from './context.ts';

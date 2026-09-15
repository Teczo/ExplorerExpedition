/**
 * The repository layer (EXPD-004).
 *
 * Everything that talks to PostgreSQL goes through here, so that tenant
 * isolation is one thing in one place rather than a rule everybody has to
 * remember.
 *
 * Where to look:
 *
 *   `queryable.ts`         The hole the database driver goes in (EXPD-016).
 *   `tables.ts`            Which tables belong to an organisation.
 *   `sql.ts`               Building parameterised statements.
 *   `tenant-repository.ts` Reads and writes, always scoped to one organisation.
 *   `global-repository.ts` The four tables that belong to nobody.
 *   `errors.ts`            What it throws when a call would break isolation.
 */

export * from './queryable.ts';
export * from './errors.ts';
export * from './tables.ts';
export * from './sql.ts';
export * from './tenant-repository.ts';
export * from './global-repository.ts';

/**
 * The mission type registry (EXPD-009).
 *
 * Where to look:
 *
 *   `behaviour.ts`  The runtime behaviour a type plugs in.
 *   `errors.ts`     What goes wrong, and what it says.
 *   `registry.ts`   The registry itself.
 *
 * The data half of a mission type — what it is, what settings it takes — is
 * in `@explorer/shared-types`, so that the Studio and the student app can
 * read a type without the engine.
 */

export * from './behaviour.ts';
export * from './errors.ts';
export * from './registry.ts';

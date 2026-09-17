/**
 * Shared type definitions for the Explorer Expedition Platform.
 *
 * This package is the single place where types crossing a package or app
 * boundary live. Nothing here should import from an app.
 *
 * The Expedition Definition schema (EXPD-002) lives in `./expedition`, and is
 * re-exported at the bottom of this file. The small helpers below are used by
 * it and by everything else that crosses a boundary.
 */

/**
 * A string id tagged with the kind of thing it points at.
 *
 * Tagging keeps two different id kinds from being mixed up by accident.
 * Example: `Id<'expedition'>` cannot be passed where `Id<'team'>` is wanted.
 */
export type Id<TKind extends string> = string & { readonly __kind: TKind };

/** Builds a tagged id from a plain string. */
export function toId<TKind extends string>(value: string): Id<TKind> {
  return value as Id<TKind>;
}

/** The workspaces that make up the platform. */
export const APP_NAMES = [
  'api',
  'creator-web',
  'studio',
  'admin',
  'student-mobile',
] as const;

/** The name of one of the platform apps. */
export type AppName = (typeof APP_NAMES)[number];

/**
 * The Expedition Definition schema (EXPD-002).
 *
 * Re-exported here so that callers can write
 * `import type { ExpeditionDefinition } from '@explorer/shared-types'`.
 */
export * from './expedition/index.ts';

/**
 * The mission type vocabulary (EXPD-009).
 *
 * What a mission type is, the schema language it describes its settings with,
 * and the checks that run over both. Re-exported for the same reason as the
 * Expedition Definition above.
 */
export * from './mission-type/index.ts';

/**
 * The mission state vocabulary (EXPD-010).
 *
 * Where one team stands on one mission, the words for every change it can
 * make, and the line written down when it does. The rules behind those words
 * are the state machine in `@explorer/engine`. Re-exported for the same
 * reason as the two above.
 */
export * from './mission-state/index.ts';

/**
 * The completion and validation vocabulary (EXPD-011).
 *
 * What came of checking a team's work, what checked it, and whether a person
 * still has to look. The interface that produces one is in
 * `@explorer/engine`. Re-exported for the same reason as the three above.
 */
export * from './completion/index.ts';

/**
 * The scoring vocabulary (EXPD-012).
 *
 * What a team's score is, why it moved, and the line written down each time
 * it does. The rules that work out what a verdict is worth are the scoring
 * engine in `@explorer/engine`. Re-exported for the same reason as the four
 * above.
 */
export * from './scoring/index.ts';

/**
 * Auth and organisation tenancy (EXPD-004).
 *
 * Roles, permissions and principals. Re-exported for the same reason as the
 * Expedition Definition above.
 */
export * from './auth/index.ts';

/**
 * The audit log (EXPD-006).
 *
 * What an entry says, and the closed list of things it can say happened.
 * Re-exported for the same reason as the two above.
 */
export * from './audit/index.ts';

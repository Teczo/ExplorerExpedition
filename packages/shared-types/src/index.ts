/**
 * Shared type definitions for the Explorer Expedition Platform.
 *
 * This package is the single place where types crossing a package or app
 * boundary live. Nothing here should import from an app.
 *
 * The Expedition Definition schema is EXPD-002 and is not part of this
 * scaffold. Until then this file only carries the small helpers below.
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

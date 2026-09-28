/**
 * Versions of one mission type, and how the next one is chosen (EXPD-031).
 *
 * A published type is never edited. A change is a new row under the same key
 * with a higher version, so that a mission pinned to the old one keeps
 * playing exactly what its author placed. These helpers say which version is
 * higher, and what the next one would be.
 *
 * The version has the shape `mission_type.version` requires: three
 * dot-separated whole numbers. `parseSchemaVersion` already reads that shape,
 * so it is reused rather than written again.
 */

import { parseSchemaVersion } from '../expedition/version.ts';

/** Which part of a version a new one raises. */
export const MISSION_TYPE_VERSION_BUMPS = ['major', 'minor', 'patch'] as const;

/** Which part of a version a new one raises. */
export type MissionTypeVersionBump = (typeof MISSION_TYPE_VERSION_BUMPS)[number];

/**
 * Orders two versions: below zero when `left` is lower, zero when equal,
 * above zero when higher. Returns `null` when either is not a version.
 */
export function compareMissionTypeVersions(left: string, right: string): number | null {
  const a = parseSchemaVersion(left);
  const b = parseSchemaVersion(right);
  if (a === null || b === null) {
    return null;
  }
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** The highest of some versions. Anything that is not a version is skipped. */
export function highestMissionTypeVersion(versions: readonly string[]): string | null {
  let highest: string | null = null;
  for (const version of versions) {
    if (parseSchemaVersion(version) === null) {
      continue;
    }
    if (highest === null || (compareMissionTypeVersions(version, highest) ?? 0) > 0) {
      highest = version;
    }
  }
  return highest;
}

/**
 * The version after `version`, raising one part and zeroing the parts after
 * it. Returns `null` when `version` is not a version.
 */
export function nextMissionTypeVersion(
  version: string,
  bump: MissionTypeVersionBump,
): string | null {
  const parts = parseSchemaVersion(version);
  if (parts === null) {
    return null;
  }
  switch (bump) {
    case 'major':
      return `${parts.major + 1}.0.0`;
    case 'minor':
      return `${parts.major}.${parts.minor + 1}.0`;
    case 'patch':
      return `${parts.major}.${parts.minor}.${parts.patch + 1}`;
  }
}

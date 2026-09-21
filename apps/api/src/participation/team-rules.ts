/**
 * The limits a run plays by, read out of the revision it is pinned to
 * (EXPD-018).
 *
 * `TeamRules` (EXPD-002) says how big a team may be, how many teams there may
 * be, and which role names a team may hand out. The run does not carry a copy
 * of any of that: it carries `expedition_version_id`, and the revision
 * carries the document. So the limits are read from the document every time
 * they are enforced, and a run that was started on revision 3 goes on playing
 * revision 3's rules however much the author changes afterwards. That is what
 * pinning a revision is for.
 *
 * Everything here reads the document defensively. `expedition_version.definition`
 * is `jsonb`, so what comes back out of the database is JSON and not a typed
 * object, and a revision written by an older schema version may be missing
 * fields this file wants. A missing field falls back to the value below
 * rather than throwing, because refusing to let a class join over a missing
 * optional field would be the worse failure by a distance.
 */

import type { JsonObject, TeamRules } from '@explorer/shared-types';

/**
 * What the rules are taken to be when the document does not say.
 *
 * Wide on purpose. These are the numbers a run falls back to when its
 * document is older or shorter than expected, and a fallback that stopped
 * students joining would turn a small gap in a document into a lesson nobody
 * can start.
 */
export const DEFAULT_TEAM_RULES: TeamRules = {
  size: { min: 1, max: 6 },
  maxTeams: null,
  roles: [],
  requireFullTeamToStart: false,
};

/** The largest team size this file will read out of a document. */
export const MAX_TEAM_SIZE = 50;

/** The most teams this file will read out of a document. */
export const MAX_TEAMS = 500;

/**
 * Reads `rules.teams` out of a stored document.
 *
 * Each field is taken only when it is the right shape, and falls back to
 * `DEFAULT_TEAM_RULES` when it is not. `size` is read as a pair and not
 * field by field, so a document cannot produce a range whose minimum is above
 * its maximum.
 */
export function teamRulesOf(definition: JsonObject | null | undefined): TeamRules {
  const rules = objectAt(definition, 'rules');
  const teams = objectAt(rules, 'teams');
  if (teams === null) {
    return DEFAULT_TEAM_RULES;
  }

  return {
    size: sizeOf(teams['size']),
    maxTeams: maxTeamsOf(teams['maxTeams']),
    roles: rolesOf(teams['roles']),
    requireFullTeamToStart: teams['requireFullTeamToStart'] === true,
  };
}

/**
 * The most students a run can hold.
 *
 * `null` means no limit this ticket knows about. A run is only capped when
 * the author capped the number of teams: that many teams, each as full as a
 * team may be. With `maxTeams` left open there is nothing here to work from,
 * and what an organisation has paid for is EXPD-069's question rather than
 * this one's.
 */
export function participantCapacityOf(rules: TeamRules): number | null {
  return rules.maxTeams === null ? null : rules.maxTeams * rules.size.max;
}

/** Returns true when the role is one the expedition hands out. */
export function isRoleOf(rules: TeamRules, role: string): boolean {
  return rules.roles.includes(role);
}

function sizeOf(value: unknown): TeamRules['size'] {
  const range = asObject(value);
  if (range === null) {
    return DEFAULT_TEAM_RULES.size;
  }

  const min = countAt(range['min'], 1, MAX_TEAM_SIZE);
  const max = countAt(range['max'], 1, MAX_TEAM_SIZE);
  if (min === null || max === null || min > max) {
    return DEFAULT_TEAM_RULES.size;
  }
  return { min, max };
}

function maxTeamsOf(value: unknown): number | null {
  return value === null || value === undefined ? null : countAt(value, 1, MAX_TEAMS);
}

function rolesOf(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const names = value.filter(
    (name): name is string => typeof name === 'string' && name.trim() !== '',
  );
  return [...new Set(names)];
}

/** A whole number inside a range, or null when it is neither. */
function countAt(value: unknown, low: number, high: number): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return null;
  }
  return value < low || value > high ? null : value;
}

function objectAt(
  parent: JsonObject | Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> | null {
  if (parent === null || parent === undefined) {
    return null;
  }
  return asObject((parent as Record<string, unknown>)[key]);
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

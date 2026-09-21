/**
 * The fake teams (EXPD-015).
 *
 * A team in a simulated run is six dials and a route. It is deliberately not
 * a model of a class of children: what the harness is for is finding out
 * whether an expedition can be played, how long it takes and where it goes
 * wrong, and those three questions are answered by a team that is sometimes
 * right, sometimes slow, and sometimes gives up.
 *
 * The dials are gathered here for the same reason every policy in this
 * package is gathered: a caller turning one should not have to build
 * anything else to turn it. `simulatedTeams` below is the other half of that
 * — a class of teams spread from quick to slow, so the commonest use of the
 * harness is a number rather than a list of objects.
 *
 * **Nothing here reads a clock or a random number.** A team is a plain value.
 * What it actually does on the day is `run.ts`, given one of these and a
 * generator.
 */

import type { RouteId, Seconds } from '@explorer/shared-types';

/** What one fake team is called. */
export type SimulatedTeamId = string;

/** One fake team. */
export interface SimulatedTeam {
  /** What to call it in the report. */
  readonly id: SimulatedTeamId;
  /**
   * How often they get a mission right, from 0 to 1.
   *
   * Rolled once per attempt. A team on 0.5 gets about half their attempts
   * right, which on a mission with three tries means they usually finish it.
   */
  readonly skill: number;
  /** How long one attempt takes them, in seconds, before jitter. */
  readonly paceSeconds: Seconds;
  /** How long they take getting to the next stop, in seconds, before jitter. */
  readonly travelSeconds: Seconds;
  /**
   * How often they walk away from a mission they are allowed to walk away
   * from, from 0 to 1.
   *
   * Rolled after a wrong answer, and only when the expedition's rules let a
   * team skip at all (EXPD-010). A team on 0 never gives up and uses every
   * try the mission allows.
   */
  readonly givesUp: number;
  /**
   * How often they open a hint before an attempt, from 0 to 1.
   *
   * Rolled before each attempt on a mission that still has an unopened hint,
   * and only when the expedition has hints turned on. What opening one costs
   * is the `hint-penalty` rule (EXPD-012).
   */
  readonly usesHints: number;
  /** The routes they are on (EXPD-013). Empty means no named route. */
  readonly routeIds: readonly RouteId[];
}

/**
 * The team a run uses when nobody says otherwise.
 *
 * A middling team: right about two attempts in three, three minutes on a
 * mission, one minute between stops, rarely gives up, sometimes takes a hint.
 * The numbers are a starting point an author can argue with rather than a
 * claim about real classes, and every one of them is a dial.
 */
export const DEFAULT_SIMULATED_TEAM: Omit<SimulatedTeam, 'id'> = {
  skill: 0.65,
  paceSeconds: 180,
  travelSeconds: 60,
  givesUp: 0.1,
  usesHints: 0.2,
  routeIds: [],
};

/** Keeps a nought-to-one dial inside nought and one. */
function share(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, value));
}

/** Keeps a length of time at nought or above. */
function seconds(value: Seconds | undefined, fallback: Seconds): Seconds {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.round(value);
}

/**
 * One team, with every dial left at its default unless it is named.
 *
 * Out-of-range dials are brought back into range rather than refused: a
 * `skill` of 2 is a caller meaning "always right", and stopping a run over it
 * would help nobody.
 */
export function simulatedTeam(
  id: SimulatedTeamId,
  over: Partial<Omit<SimulatedTeam, 'id'>> = {},
): SimulatedTeam {
  return {
    id,
    skill: share(over.skill, DEFAULT_SIMULATED_TEAM.skill),
    paceSeconds: seconds(over.paceSeconds, DEFAULT_SIMULATED_TEAM.paceSeconds),
    travelSeconds: seconds(over.travelSeconds, DEFAULT_SIMULATED_TEAM.travelSeconds),
    givesUp: share(over.givesUp, DEFAULT_SIMULATED_TEAM.givesUp),
    usesHints: share(over.usesHints, DEFAULT_SIMULATED_TEAM.usesHints),
    routeIds: over.routeIds ?? DEFAULT_SIMULATED_TEAM.routeIds,
  };
}

/** How a class of teams is spread out. */
export interface SimulatedClassOptions {
  /**
   * The routes to deal out, one team at a time and round again.
   *
   * A duration estimate over an expedition with routes in it is only worth
   * anything if somebody walked each of them, and dealing rather than
   * randomising means the first team is always on the first route.
   */
  readonly routeIds?: readonly RouteId[];
  /** The middling team the spread is built around. */
  readonly around?: Partial<Omit<SimulatedTeam, 'id' | 'routeIds'>>;
  /**
   * How far either side of it the quickest and slowest teams sit, from 0 to 1.
   *
   * 0 makes every team identical, which is what a caller measuring one
   * change wants. The default spreads skill and pace by a third either way,
   * so a class of three holds a team that races, a team that plods and one
   * in between.
   */
  readonly spread?: number;
}

/**
 * A class of teams, spread from quick and able to slow and struggling.
 *
 * The spread is worked out from the team's place in the list rather than from
 * a random number, so `simulatedTeams(5)` is the same five teams every time
 * and team 1 is always the quickest. A class of one is the middling team
 * exactly.
 */
export function simulatedTeams(
  count: number,
  options: SimulatedClassOptions = {},
): SimulatedTeam[] {
  const wanted = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  const middle = simulatedTeam('middle', options.around ?? {});
  const spread = share(options.spread, 1 / 3);
  const routes = options.routeIds ?? [];
  const teams: SimulatedTeam[] = [];

  for (let index = 0; index < wanted; index += 1) {
    // From +1 for the first team down to -1 for the last, and exactly 0 for a
    // class of one.
    const place = wanted === 1 ? 0 : 1 - (2 * index) / (wanted - 1);
    const routeId = routes.length === 0 ? undefined : routes[index % routes.length];
    teams.push(
      simulatedTeam(`team-${String(index + 1)}`, {
        skill: middle.skill * (1 + place * spread),
        paceSeconds: Math.round(middle.paceSeconds * (1 - place * spread)),
        travelSeconds: Math.round(middle.travelSeconds * (1 - place * spread)),
        givesUp: middle.givesUp,
        usesHints: middle.usesHints,
        routeIds: routeId === undefined ? [] : [routeId],
      }),
    );
  }

  return teams;
}

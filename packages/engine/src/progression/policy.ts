/**
 * What the definition says about how a team moves through it (EXPD-013).
 *
 * Progression reads two things out of the document. The graph is what the
 * expedition *is*: the stops, the edges between them, the condition on each
 * edge, which stops a team may walk past and which ones stay hidden. The
 * progression mode is how freely a team moves across it, and the routes are
 * the named ways through that only some teams walk.
 *
 * They are gathered into one small value for the same two reasons
 * `MissionStatePolicy` (EXPD-010), `MissionCompletionPolicy` (EXPD-011) and
 * `MissionScoringPolicy` (EXPD-012) gather theirs: progression has no
 * business reading a mission's title, its hints or its scoring, and the
 * simulation harness (EXPD-015) wants to turn `strict` into `open` without
 * building a whole expedition to do it.
 *
 * **The engine reads these and never the definition.** Reading `progression`
 * off the rules in one place and off a policy in another is how the two would
 * come to disagree.
 *
 * Everything else in those documents belongs elsewhere. `allowSkip` and
 * `attempts` are the state machine's (EXPD-010) — whether a team may give up
 * on a mission is about that mission, not about the shape of the expedition.
 * `timing` is the session's (EXPD-019); the engine holds no clock, so how
 * long a team has been playing arrives on the situation instead.
 */

import type {
  ExpeditionDefinition,
  ExpeditionGraph,
  ProgressionMode,
  RouteId,
} from '@explorer/shared-types';

/** What the definition says about how a team moves through it. */
export interface ProgressionPolicy {
  /** How freely a team may move across the graph. */
  readonly mode: ProgressionMode;
  /** The stops and the links between them. */
  readonly graph: ExpeditionGraph;
  /**
   * Every route the expedition declares.
   *
   * Held so that an edge naming a route this expedition does not have can be
   * told apart from an edge naming a route the team is simply not on. The
   * first is a broken document; the second is somebody else's path.
   */
  readonly routeIds: readonly RouteId[];
}

/**
 * What an expedition progresses under when nobody says otherwise.
 *
 * No stops, no routes, and the strictest mode there is. A caller that forgets
 * to pass a policy gets an expedition where nothing is open rather than one
 * where everything is, the same caution the other three defaults take.
 */
export const DEFAULT_PROGRESSION_POLICY: ProgressionPolicy = {
  mode: 'strict',
  graph: { nodes: [], edges: [] },
  routeIds: [],
};

/**
 * Reads the policy out of the document that holds it.
 *
 * It takes the whole definition because progression is the one part of the
 * engine whose question spans the document: the mode is on the rules, the
 * routes are on the rules, and the shape is the graph.
 */
export function progressionPolicyFor(
  definition: ExpeditionDefinition,
): ProgressionPolicy {
  return {
    mode: definition.rules?.progression ?? DEFAULT_PROGRESSION_POLICY.mode,
    graph: definition.graph ?? { nodes: [], edges: [] },
    routeIds: (definition.rules?.routes ?? []).map((route) => route.id),
  };
}

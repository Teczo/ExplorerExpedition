/**
 * Which teams an edge is for (EXPD-013).
 *
 * An expedition may send two halves of a class different ways: the walkers
 * round the lake, the cyclists over the hill. The schema (EXPD-002) holds one
 * graph for both and lets each edge say which routes may take it, so that an
 * author draws one expedition rather than two.
 *
 * A route is not a condition. A condition is something a team can make true
 * by playing — finish a mission, earn some points, wait long enough. A route
 * is decided before they start (EXPD-018) and nothing they do changes it, so
 * an edge their route is not named on is not a locked door. It is somebody
 * else's path, and the stops beyond it are not theirs to reach.
 */

import type { EdgeAudience, RouteId } from '@explorer/shared-types';

/**
 * Says whether a team on these routes may take an edge with this audience.
 *
 * An edge with no audience is for everybody, which is what the schema says
 * leaving it out means. An edge for named routes wants one of them, and a
 * team on none of them stays where they are.
 *
 * An audience naming no route at all is for nobody. The validator turns that
 * document away, so this is only what the engine does when it is handed one
 * anyway: it keeps the edge shut rather than throwing it open.
 */
export function audienceCoversTeam(
  audience: EdgeAudience | undefined,
  routeIds: readonly RouteId[],
): boolean {
  if (audience === undefined || audience.kind === 'all') {
    return true;
  }
  return audience.routeIds.some((routeId) => routeIds.includes(routeId));
}

/** Says whether an edge is for some routes rather than for everybody. */
export function isRouteSpecific(audience: EdgeAudience | undefined): boolean {
  return audience !== undefined && audience.kind === 'routes';
}

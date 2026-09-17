/**
 * What the progression tests are played against.
 *
 * Progression reads a graph, a mode, a list of routes and what a team has
 * done. Nothing else in a definition reaches it, so nothing else is built
 * here: these make stops, edges between them, and a team that has finished
 * some missions and earned some points.
 */

import type {
  EdgeId,
  ExpeditionEdge,
  ExpeditionNode,
  MissionInstanceId,
  MissionState,
  NodeId,
  ProgressionMode,
  RouteId,
  UnlockCondition,
} from '@explorer/shared-types';

import type { ProgressionPolicy } from '../../src/progression/policy.ts';
import type { TeamSituation } from '../../src/progression/situation.ts';

/** A node id, tagged. */
export function nodeId(name: string): NodeId {
  return name as NodeId;
}

/** A mission id, tagged. */
export function missionId(name: string): MissionInstanceId {
  return name as MissionInstanceId;
}

/** An edge id, tagged. */
export function edgeId(name: string): EdgeId {
  return name as EdgeId;
}

/** A route id, tagged. */
export function routeId(name: string): RouteId {
  return name as RouteId;
}

/** Where every team begins. */
export function start(name = 'start'): ExpeditionNode {
  return { id: nodeId(name), title: 'Start', kind: 'start' };
}

/** A stop that holds one mission, named after the mission on it. */
export function mission(
  name: string,
  options: { optional?: boolean; secret?: boolean; node?: string } = {},
): ExpeditionNode {
  return {
    id: nodeId(options.node ?? `node-${name}`),
    title: name,
    kind: 'mission',
    missionInstanceId: missionId(name),
    ...(options.optional === undefined ? {} : { optional: options.optional }),
    ...(options.secret === undefined ? {} : { secret: options.secret }),
  };
}

/** A stop that holds nothing. */
export function checkpoint(name: string): ExpeditionNode {
  return { id: nodeId(name), title: name, kind: 'checkpoint' };
}

/** Where the expedition ends. */
export function finish(name = 'finish'): ExpeditionNode {
  return { id: nodeId(name), title: 'Finish', kind: 'finish' };
}

/** A one-way link, id'd after the two stops it joins. */
export function edge(
  from: string,
  to: string,
  options: { condition?: UnlockCondition; routes?: string[] } = {},
): ExpeditionEdge {
  return {
    id: edgeId(`${from}->${to}`),
    from: nodeId(from),
    to: nodeId(to),
    ...(options.condition === undefined ? {} : { condition: options.condition }),
    ...(options.routes === undefined
      ? {}
      : { audience: { kind: 'routes', routeIds: options.routes.map(routeId) } }),
  };
}

/** A policy holding only what the progression engine reads off a definition. */
export function policyOf(
  nodes: ExpeditionNode[],
  edges: ExpeditionEdge[],
  options: { mode?: ProgressionMode; routes?: string[] } = {},
): ProgressionPolicy {
  return {
    mode: options.mode ?? 'open',
    graph: { nodes, edges },
    routeIds: (options.routes ?? []).map(routeId),
  };
}

/** What a team has done, with everything they have not done left out. */
export function situationOf(
  options: {
    states?: Record<string, MissionState>;
    missionPoints?: Record<string, number>;
    totalPoints?: number;
    elapsedSeconds?: number;
    routes?: string[];
  } = {},
): TeamSituation {
  const states = new Map<MissionInstanceId, MissionState>();
  for (const [name, state] of Object.entries(options.states ?? {})) {
    states.set(missionId(name), state);
  }
  const points = new Map<MissionInstanceId, number>();
  for (const [name, value] of Object.entries(options.missionPoints ?? {})) {
    points.set(missionId(name), value);
  }
  return {
    missionStates: states,
    missionPoints: points,
    totalPoints: options.totalPoints ?? 0,
    elapsedSeconds: options.elapsedSeconds ?? 0,
    routeIds: (options.routes ?? []).map(routeId),
  };
}

/** The ids of the stops a team has reached, for a test to compare against. */
export function reachedNodeIds(nodes: readonly { nodeId: NodeId; reached: boolean }[]): string[] {
  return nodes.filter((node) => node.reached).map((node) => node.nodeId);
}

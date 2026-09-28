/**
 * Unlock conditions, routes and dependencies, and every change the property
 * panel can make to them (EXPD-029).
 *
 * An edge may carry a condition (what has to be true before it may be taken)
 * and an audience (which routes may take it). The routes themselves are
 * listed on the expedition's rules. A mission node may be optional, which
 * means it never holds a team up. This file is what lets an author set all
 * of that without writing JSON, and see what stands in front of a stop.
 *
 * Every change is a pure function from one `GraphState` to the next, the same
 * as `graph.ts`, so the tests hold it to account without a browser. What a
 * condition comes to for one team during play is the engine's (EXPD-013);
 * nothing here evaluates one.
 */

import {
  MAX_UNLOCK_CONDITION_DEPTH,
  UNLOCK_CONDITION_TYPES,
  validateExpeditionDefinition,
  type EdgeAudience,
  type ExpeditionEdge,
  type JsonObject,
  type MissionInstanceId,
  type RouteDefinition,
  type RouteId,
  type UnlockCondition,
  type UnlockConditionType,
} from '@explorer/shared-types';

import { freshId, toDocument, type GraphState } from './graph.ts';
import type { PropertyIssue } from './properties.ts';

/** How the panel names each condition type, and says what it means. */
export const CONDITION_LABELS: Record<UnlockConditionType, { readonly name: string; readonly help: string }> = {
  always: { name: 'Always', help: 'Always true.' },
  'mission-completed': { name: 'Mission finished', help: 'True once the mission is finished. Failed or skipped does not count.' },
  'mission-score-at-least': { name: 'Mission score at least', help: 'True once the mission has scored this many points or more.' },
  'total-score-at-least': { name: 'Team total at least', help: "True once the team's total is this many points or more." },
  'missions-completed-at-least': { name: 'Some of these missions finished', help: 'True once this many of the ticked missions are finished.' },
  'elapsed-time-at-least': { name: 'Time played at least', help: 'True once this long has passed since the team started.' },
  'all-of': { name: 'All of these', help: 'True when every condition inside is true. An empty group is true.' },
  'any-of': { name: 'Any of these', help: 'True when at least one condition inside is true. An empty group is false.' },
  not: { name: 'Not', help: 'True when the condition inside is false.' },
};

/** Every condition type, in the order the schema lists them. */
export const CONDITION_TYPES: readonly UnlockConditionType[] = UNLOCK_CONDITION_TYPES;

/** Whether a condition type holds other conditions. */
export function isGroup(type: UnlockConditionType): boolean {
  return type === 'all-of' || type === 'any-of' || type === 'not';
}

/** Whether a condition may hold another group at this depth. The top condition is depth 1. */
export function canNestAt(depth: number): boolean {
  return depth < MAX_UNLOCK_CONDITION_DEPTH;
}

// --- Building conditions ----------------------------------------------------

/**
 * A new condition of one type, with values the schema accepts.
 *
 * `missionId` is the mission it names, where it names one; the panel passes
 * the mission on the stop the edge leaves from, since that is what an author
 * most often means.
 */
export function newCondition(type: UnlockConditionType, missionId: string): UnlockCondition {
  const id = missionId as MissionInstanceId;
  switch (type) {
    case 'always':
      return { type };
    case 'mission-completed':
      return { type, missionInstanceId: id };
    case 'mission-score-at-least':
      return { type, missionInstanceId: id, points: 10 };
    case 'total-score-at-least':
      return { type, points: 50 };
    case 'missions-completed-at-least':
      return { type, count: 1, missionInstanceIds: missionId === '' ? [] : [id] };
    case 'elapsed-time-at-least':
      return { type, seconds: 600 };
    case 'all-of':
    case 'any-of':
      return { type, conditions: [] };
    case 'not':
      return { type, condition: newCondition('mission-completed', missionId) };
  }
}

/**
 * The same condition turned into another type, keeping what carries over.
 *
 * The mission it named stays named. Turning a test into a group puts the
 * test inside the group, so "finished A" can become "all of: finished A" and
 * then gain a second test without the first being typed again. Turning a
 * group into a test keeps its first test when that is the type asked for.
 */
export function changeConditionType(
  condition: UnlockCondition,
  type: UnlockConditionType,
  fallbackMissionId: string,
): UnlockCondition {
  if (condition.type === type) {
    return condition;
  }
  const inner = condition.type !== 'always' && !isGroup(condition.type) ? condition : undefined;
  if (type === 'all-of' || type === 'any-of') {
    if (condition.type === 'all-of' || condition.type === 'any-of') {
      return { type, conditions: condition.conditions };
    }
    if (condition.type === 'not') {
      return { type, conditions: [condition.condition] };
    }
    return { type, conditions: inner === undefined ? [] : [inner] };
  }
  if (type === 'not') {
    return { type, condition: inner ?? firstInside(condition) ?? newCondition('mission-completed', fallbackMissionId) };
  }
  const first = firstInside(condition);
  if (first !== undefined && first.type === type) {
    return first;
  }
  return newCondition(type, missionsNamed(condition)[0] ?? fallbackMissionId);
}

function firstInside(condition: UnlockCondition): UnlockCondition | undefined {
  if (condition.type === 'all-of' || condition.type === 'any-of') {
    return condition.conditions[0];
  }
  return condition.type === 'not' ? condition.condition : undefined;
}

/**
 * Sets one number a condition holds. A field the condition's type does not
 * hold is ignored.
 */
export function setConditionNumber(
  condition: UnlockCondition,
  field: 'points' | 'count' | 'seconds',
  value: number,
): UnlockCondition {
  switch (condition.type) {
    case 'mission-score-at-least':
    case 'total-score-at-least':
      return field === 'points' ? { ...condition, points: value } : condition;
    case 'missions-completed-at-least':
      return field === 'count' ? { ...condition, count: value } : condition;
    case 'elapsed-time-at-least':
      return field === 'seconds' ? { ...condition, seconds: value } : condition;
    default:
      return condition;
  }
}

/** Points a condition that names one mission at another. Any other condition is left alone. */
export function setConditionMission(condition: UnlockCondition, missionId: string): UnlockCondition {
  if (condition.type === 'mission-completed' || condition.type === 'mission-score-at-least') {
    return { ...condition, missionInstanceId: missionId as MissionInstanceId };
  }
  return condition;
}

/**
 * Ticks a mission into, or out of, the missions a "some of these" condition
 * counts. A count left larger than the list is kept, and the check says so.
 */
export function toggleConditionMission(condition: UnlockCondition, missionId: string, on: boolean): UnlockCondition {
  if (condition.type !== 'missions-completed-at-least') {
    return condition;
  }
  const without = condition.missionInstanceIds.filter((id) => id !== missionId);
  return { ...condition, missionInstanceIds: on ? [...without, missionId as MissionInstanceId] : without };
}

/** Adds a condition at the end of a group. */
export function addToGroup(condition: UnlockCondition, inner: UnlockCondition): UnlockCondition {
  if (condition.type !== 'all-of' && condition.type !== 'any-of') {
    return condition;
  }
  return { ...condition, conditions: [...condition.conditions, inner] };
}

/** Replaces the condition at `index` in a group, or inside a `not` (index 0). */
export function replaceInside(condition: UnlockCondition, index: number, inner: UnlockCondition): UnlockCondition {
  if (condition.type === 'not') {
    return index === 0 ? { ...condition, condition: inner } : condition;
  }
  if (condition.type !== 'all-of' && condition.type !== 'any-of') {
    return condition;
  }
  return { ...condition, conditions: condition.conditions.map((entry, at) => (at === index ? inner : entry)) };
}

/** Takes the condition at `index` out of a group. */
export function removeFromGroup(condition: UnlockCondition, index: number): UnlockCondition {
  if (condition.type !== 'all-of' && condition.type !== 'any-of') {
    return condition;
  }
  return { ...condition, conditions: condition.conditions.filter((_, at) => at !== index) };
}

// --- Reading conditions -----------------------------------------------------

/**
 * Every mission a condition names, however deeply it is nested, each once
 * and in document order. A mission inside a `not` is named too: the
 * condition is still about it.
 */
export function missionsNamed(condition: UnlockCondition | undefined): string[] {
  const found: string[] = [];
  const walk = (inner: UnlockCondition | undefined, depth: number): void => {
    if (inner === undefined || depth > MAX_UNLOCK_CONDITION_DEPTH) {
      return;
    }
    switch (inner.type) {
      case 'mission-completed':
      case 'mission-score-at-least':
        found.push(inner.missionInstanceId);
        break;
      case 'missions-completed-at-least':
        found.push(...inner.missionInstanceIds);
        break;
      case 'all-of':
      case 'any-of':
        inner.conditions.forEach((nested) => walk(nested, depth + 1));
        break;
      case 'not':
        walk(inner.condition, depth + 1);
        break;
      default:
        break;
    }
  };
  walk(condition, 1);
  return [...new Set(found)];
}

/**
 * A condition in plain words, for the canvas and the dependency list.
 *
 * `nameOf` turns a mission id into what the author calls it.
 */
export function describeCondition(
  condition: UnlockCondition | undefined,
  nameOf: (missionId: string) => string,
  depth = 1,
): string {
  if (condition === undefined) {
    return 'always';
  }
  if (depth > MAX_UNLOCK_CONDITION_DEPTH) {
    return '…';
  }
  switch (condition.type) {
    case 'always':
      return 'always';
    case 'mission-completed':
      return `${nameOf(condition.missionInstanceId)} finished`;
    case 'mission-score-at-least':
      return `${nameOf(condition.missionInstanceId)} ≥ ${condition.points} pts`;
    case 'total-score-at-least':
      return `total ≥ ${condition.points} pts`;
    case 'missions-completed-at-least':
      return `${condition.count} of ${condition.missionInstanceIds.length} finished`;
    case 'elapsed-time-at-least':
      return `after ${formatSeconds(condition.seconds)}`;
    case 'all-of':
    case 'any-of': {
      if (condition.conditions.length === 0) {
        return condition.type === 'all-of' ? 'always' : 'never';
      }
      const joined = condition.conditions
        .map((inner) => describeCondition(inner, nameOf, depth + 1))
        .join(condition.type === 'all-of' ? ' and ' : ' or ');
      return depth === 1 ? joined : `(${joined})`;
    }
    case 'not':
      return `not ${describeCondition(condition.condition, nameOf, depth + 1)}`;
  }
}

function formatSeconds(seconds: number): string {
  if (seconds % 60 === 0) {
    return `${seconds / 60} min`;
  }
  return `${seconds} s`;
}

// --- Changing an edge -------------------------------------------------------

function updateEdge(state: GraphState, edgeId: string, change: (edge: ExpeditionEdge) => ExpeditionEdge): GraphState {
  return { ...state, edges: state.edges.map((edge) => (edge.id === edgeId ? change(edge) : edge)) };
}

/**
 * Sets an edge's condition. `undefined` or `always` takes it off, which the
 * schema reads the same way, so an edge nobody gated stays plain.
 */
export function setEdgeCondition(state: GraphState, edgeId: string, condition: UnlockCondition | undefined): GraphState {
  return updateEdge(state, edgeId, (edge) => {
    const { condition: _dropped, ...rest } = edge;
    return condition === undefined || condition.type === 'always' ? rest : { ...rest, condition };
  });
}

/**
 * Sets which routes may take an edge. `null` means every team, which takes
 * the audience off. An empty list is kept, and the check says why it is wrong.
 */
export function setEdgeRoutes(state: GraphState, edgeId: string, routeIds: readonly string[] | null): GraphState {
  return updateEdge(state, edgeId, (edge) => {
    const { audience: _dropped, ...rest } = edge;
    if (routeIds === null) {
      return rest;
    }
    const audience: EdgeAudience = { kind: 'routes', routeIds: routeIds as RouteId[] };
    return { ...rest, audience };
  });
}

/** Ticks a route onto, or off, the routes an edge is for. */
export function toggleEdgeRoute(state: GraphState, edgeId: string, routeId: string, on: boolean): GraphState {
  const edge = state.edges.find((candidate) => candidate.id === edgeId);
  if (edge === undefined) {
    return state;
  }
  const named = edge.audience?.kind === 'routes' ? edge.audience.routeIds : [];
  const without = named.filter((id) => id !== routeId);
  return setEdgeRoutes(state, edgeId, on ? [...without, routeId] : without);
}

// --- Routes -----------------------------------------------------------------

/** The routes the expedition declares. A document with none reads as empty. */
export function routesOf(state: GraphState): RouteDefinition[] {
  const routes = rulesObject(state)['routes'];
  return Array.isArray(routes)
    ? (routes.filter((route) => typeof route === 'object' && route !== null && !Array.isArray(route)) as unknown as RouteDefinition[])
    : [];
}

/** Replaces the routes and keeps every other rule as it was read. No routes leaves the field out. */
function writeRoutes(state: GraphState, routes: readonly RouteDefinition[]): GraphState {
  const { routes: _dropped, ...rest } = rulesObject(state);
  return {
    ...state,
    document: {
      ...state.document,
      rules: routes.length === 0 ? rest : { ...rest, routes: routes as unknown as JsonObject[] },
    },
  };
}

/** Adds a route by name. Its id is made from the name, and never clashes with another. */
export function addRoute(state: GraphState, name: string): { state: GraphState; routeId: string } {
  const routes = routesOf(state);
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const base = slug === '' ? 'route' : slug;
  const taken = new Set(routes.map((route) => route.id as string));
  const routeId = taken.has(base) ? freshId(base, [...taken]) : base;
  const route: RouteDefinition = { id: routeId as RouteId, name: name.trim() };
  return { state: writeRoutes(state, [...routes, route]), routeId };
}

/** Renames a route. Its id, which edges point at, stays the same. */
export function renameRoute(state: GraphState, routeId: string, name: string): GraphState {
  return writeRoutes(
    state,
    routesOf(state).map((route) => (route.id === routeId ? { ...route, name } : route)),
  );
}

/**
 * Removes a route, and takes it off every edge that named it.
 *
 * An edge left naming no route is kept that way rather than opened to every
 * team, which would quietly change who walks it; the check says so.
 */
export function removeRoute(state: GraphState, routeId: string): GraphState {
  const without = writeRoutes(state, routesOf(state).filter((route) => route.id !== routeId));
  return {
    ...without,
    edges: without.edges.map((edge) =>
      edge.audience?.kind === 'routes' && edge.audience.routeIds.includes(routeId as RouteId)
        ? { ...edge, audience: { kind: 'routes', routeIds: edge.audience.routeIds.filter((id) => id !== routeId) } }
        : edge,
    ),
  };
}

/** How freely teams move through the graph, as the rules say. `free-roam` ignores every condition. */
export function progressionOf(state: GraphState): string | undefined {
  const progression = rulesObject(state)['progression'];
  return typeof progression === 'string' ? progression : undefined;
}

// --- Dependencies -----------------------------------------------------------

/** One way into a stop, as the dependency list shows it. */
export interface WayIn {
  readonly edge: ExpeditionEdge;
  /** The mission on the stop the edge leaves from, when that stop must be cleared first. */
  readonly clearFirst: string | undefined;
  /** Every mission the edge's condition names. */
  readonly named: readonly string[];
}

/**
 * Every edge into a stop, and what each one waits on.
 *
 * Two things put a mission in front of a stop: the stop before it holds one
 * that is not optional, or a condition on the edge names one. This is one
 * step back, the same question the engine answers in `missionsRequiredBefore`
 * (EXPD-013).
 */
export function waysInto(state: GraphState, nodeId: string): WayIn[] {
  return state.edges
    .filter((edge) => edge.to === nodeId)
    .map((edge) => {
      const from = state.nodes.find((node) => node.id === edge.from);
      const clearFirst =
        from !== undefined && from.kind === 'mission' && from.optional !== true ? from.missionInstanceId : undefined;
      return { edge, clearFirst, named: missionsNamed(edge.condition) };
    });
}

/** Every edge whose condition names this mission: the stops that wait on it. */
export function edgesWaitingOn(state: GraphState, missionId: string): ExpeditionEdge[] {
  return state.edges.filter((edge) => missionsNamed(edge.condition).includes(missionId));
}

// --- What is wrong with it --------------------------------------------------

/**
 * Every problem `validateExpeditionDefinition` finds on one edge, with paths
 * made relative to it: `condition.conditions[0].points`, `audience.routeIds`.
 */
export function issuesOfEdge(state: GraphState, edgeId: string): PropertyIssue[] {
  const index = state.edges.findIndex((edge) => edge.id === edgeId);
  return issuesUnder(state, `graph.edges[${index}]`);
}

/** Every problem with the routes, with paths made relative to `rules.routes`. */
export function issuesOfRoutes(state: GraphState): PropertyIssue[] {
  return issuesUnder(state, 'rules.routes');
}

function issuesUnder(state: GraphState, prefix: string): PropertyIssue[] {
  const result = validateExpeditionDefinition(toDocument(state));
  if (result.valid) {
    return [];
  }
  return result.issues
    .filter((issue) => issue.path === prefix || issue.path.startsWith(`${prefix}.`) || issue.path.startsWith(`${prefix}[`))
    .map((issue) => ({ path: issue.path.slice(prefix.length).replace(/^\./, ''), message: issue.message }));
}

function rulesObject(state: GraphState): JsonObject {
  const rules = state.document['rules'];
  return typeof rules === 'object' && rules !== null && !Array.isArray(rules) ? (rules as JsonObject) : {};
}

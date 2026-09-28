/**
 * The expedition graph as the editor holds it, and every change the editor
 * can make to it (EXPD-026).
 *
 * The editor works on three lists — nodes, edges and the missions the nodes
 * hold — and keeps the rest of the document exactly as it was read, so that
 * saving a graph never loses a field another screen wrote. Every change here
 * is a pure function from one state to the next, which is what lets the
 * tests hold it to account without a browser.
 *
 * The schema has four node kinds (start, mission, checkpoint, finish). The
 * editor offers seven things to place, and the extra three are built from
 * them:
 *
 *   secret mission     a mission node with `secret: true`
 *   boss               a mission node with `boss: true`
 *   parallel stations  a checkpoint that splits into several missions, and
 *                      one that gathers them back up
 *   branch             a checkpoint with two labelled paths out of it, and
 *                      one where they meet again
 *
 * What makes one path of a branch open rather than the other is an edge's
 * condition or route. Editing those is `unlock.ts` (EXPD-029).
 */

import {
  EXPEDITION_SCHEMA_VERSION,
  validateExpeditionDefinition,
  type ExpeditionEdge,
  type ExpeditionNode,
  type JsonObject,
  type MissionInstance,
  type MissionTypeAuthoring,
  type MissionTypeDefinition,
  type ValidationIssue,
} from '@explorer/shared-types';

/** How big a node is drawn. Layout positions are its top-left corner. */
export const NODE_WIDTH = 168;
export const NODE_HEIGHT = 56;

/** The gap between columns and rows when the editor places nodes itself. */
const COLUMN = NODE_WIDTH + 72;
const ROW = NODE_HEIGHT + 40;
const MARGIN = 40;

/** Everything the editor holds. */
export interface GraphState {
  /** The document as it was read. Only the three lists below are replaced. */
  readonly document: JsonObject;
  readonly nodes: readonly ExpeditionNode[];
  readonly edges: readonly ExpeditionEdge[];
  readonly missions: readonly MissionInstance[];
}

/** What the editor needs to know about a mission type to place one. */
export type MissionTypeChoice = Pick<
  MissionTypeDefinition,
  'key' | 'version' | 'name' | 'description' | 'defaultConfig'
> &
  Pick<MissionTypeAuthoring, 'validationMethod' | 'defaultScoring'>;

/** How the editor draws a node. A mission can be a boss and secret at once. */
export type NodeRole = 'start' | 'mission' | 'secret' | 'boss' | 'checkpoint' | 'finish';

/** A point on the canvas. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

// --- Reading and writing the document ---------------------------------------

/**
 * Reads a stored document into the editor.
 *
 * A draft may be half-built: no graph at all, or nodes that were never given
 * a place on the canvas. Missing lists read as empty, and a node with no
 * layout is placed in columns by how far it is from the start.
 */
export function openDocument(document: JsonObject): GraphState {
  const graph = asObject(document['graph']);
  const nodes = asList<ExpeditionNode>(graph['nodes']);
  const edges = asList<ExpeditionEdge>(graph['edges']);
  const missions = asList<MissionInstance>(document['missions']);
  return { document, nodes: placeUnplaced(nodes, edges), edges, missions };
}

/**
 * The document to save.
 *
 * It is written at this build's schema version, because the editor may have
 * used a field (`boss`) an older version does not have.
 */
export function toDocument(state: GraphState): JsonObject {
  const graph = asObject(state.document['graph']);
  return {
    ...state.document,
    schemaVersion: EXPEDITION_SCHEMA_VERSION,
    missions: state.missions as unknown as JsonObject[],
    graph: {
      ...graph,
      nodes: state.nodes as unknown as JsonObject[],
      edges: state.edges as unknown as JsonObject[],
    },
  };
}

/** What a new expedition starts with: a start, a finish, and nothing between. */
export function startingGraph(): { nodes: ExpeditionNode[]; edges: ExpeditionEdge[] } {
  return {
    nodes: [
      { id: 'start' as ExpeditionNode['id'], kind: 'start', title: 'Start', layout: { x: MARGIN, y: MARGIN } },
      {
        id: 'finish' as ExpeditionNode['id'],
        kind: 'finish',
        title: 'Finish',
        layout: { x: MARGIN + COLUMN * 3, y: MARGIN },
      },
    ],
    edges: [],
  };
}

// --- What a node is ---------------------------------------------------------

/** How the editor draws a node. Boss wins over secret; both are shown as badges. */
export function roleOf(node: ExpeditionNode): NodeRole {
  if (node.kind !== 'mission') {
    return node.kind;
  }
  if (node.boss === true) {
    return 'boss';
  }
  return node.secret === true ? 'secret' : 'mission';
}

/** Where a node is drawn. A node the editor has not placed yet sits at the margin. */
export function positionOf(node: ExpeditionNode): Point {
  return node.layout ?? { x: MARGIN, y: MARGIN };
}

/** The mission a node holds, if it holds one that exists. */
export function missionOf(state: GraphState, node: ExpeditionNode): MissionInstance | undefined {
  return node.kind === 'mission'
    ? state.missions.find((mission) => mission.id === node.missionInstanceId)
    : undefined;
}

// --- Placing things ---------------------------------------------------------

/** What can be placed from the palette as a single node. */
export type NodeSpec =
  | { readonly kind: 'start' | 'checkpoint' | 'finish' }
  | {
      readonly kind: 'mission';
      readonly type: MissionTypeChoice;
      readonly secret?: boolean;
      readonly boss?: boolean;
    };

/** A state, and the node that was just added to it. */
export interface Added {
  readonly state: GraphState;
  readonly nodeId: string;
}

/**
 * Adds one node.
 *
 * With `after`, it is placed to the right of that node and joined to it, so
 * an author can lay a line of stops down by clicking. The join is skipped
 * when it would not be allowed (after a finish, say).
 */
export function addNode(state: GraphState, spec: NodeSpec, after?: string): Added {
  const at = freeSpot(state, after);
  let next: GraphState;
  let nodeId: string;

  if (spec.kind === 'mission') {
    const title = spec.boss === true ? `Boss: ${spec.type.name}` : spec.type.name;
    ({ state: next, nodeId } = placeMission(state, spec.type, title, at, {
      secret: spec.secret === true,
      boss: spec.boss === true,
    }));
  } else {
    nodeId = freshId('node', state.nodes.map((node) => node.id));
    const node = { id: nodeId, kind: spec.kind, title: DEFAULT_TITLES[spec.kind], layout: at } as ExpeditionNode;
    next = { ...state, nodes: [...state.nodes, node] };
  }

  return { state: joinIfAllowed(next, after, nodeId), nodeId };
}

/**
 * Adds parallel stations: a split, `count` missions side by side, and a join.
 *
 * Every station opens when the team reaches the split, and the join opens
 * once they have cleared every one of them. With `after`, the split is joined
 * to that node. Returns the join, which is where the next stop goes.
 */
export function addParallelStations(
  state: GraphState,
  type: MissionTypeChoice,
  count: number,
  after?: string,
): Added {
  const stations = Math.max(2, Math.min(8, Math.floor(count)));
  const labels = Array.from({ length: stations }, (_, index) => ({
    title: `${type.name} ${index + 1}`,
  }));
  return addFork(state, type, labels, 'Stations', 'All stations done', after);
}

/**
 * Adds a branch: a split with two labelled paths out of it, and a join.
 *
 * The labels are the author's. Making one path open rather than the other is
 * a condition or a route on its edge (EXPD-029). Returns the join.
 */
export function addBranch(state: GraphState, type: MissionTypeChoice, after?: string): Added {
  return addFork(
    state,
    type,
    [
      { title: `${type.name} (path A)`, label: 'Path A' },
      { title: `${type.name} (path B)`, label: 'Path B' },
    ],
    'Branch',
    'Paths meet',
    after,
  );
}

function addFork(
  state: GraphState,
  type: MissionTypeChoice,
  arms: readonly { title: string; label?: string }[],
  splitTitle: string,
  joinTitle: string,
  after?: string,
): Added {
  // The split, the arms beside it and the join after them, moved down as one
  // until none of them lands on a node already there.
  let origin = freeSpot(state, after);
  let armTop = Math.max(MARGIN, origin.y - ((arms.length - 1) * ROW) / 2);
  const spots = () => [
    origin,
    { x: origin.x + COLUMN * 2, y: origin.y },
    ...arms.map((_, index) => ({ x: origin.x + COLUMN, y: armTop + index * ROW })),
  ];
  while (spots().some((spot) => state.nodes.some((node) => overlaps(positionOf(node), spot)))) {
    origin = { x: origin.x, y: origin.y + ROW };
    armTop += ROW;
  }

  let next = addCheckpointAt(state, splitTitle, { x: origin.x, y: origin.y });
  const splitId = next.nodeId;
  next = { state: joinIfAllowed(next.state, after, splitId), nodeId: splitId };

  const armIds: string[] = [];
  arms.forEach((arm, index) => {
    const placed = placeMission(next.state, type, arm.title, {
      x: origin.x + COLUMN,
      y: armTop + index * ROW,
    });
    armIds.push(placed.nodeId);
    next = { state: link(placed.state, splitId, placed.nodeId, arm.label), nodeId: placed.nodeId };
  });

  const join = addCheckpointAt(next.state, joinTitle, { x: origin.x + COLUMN * 2, y: origin.y });
  let final = join.state;
  for (const armId of armIds) {
    final = link(final, armId, join.nodeId);
  }
  return { state: final, nodeId: join.nodeId };
}

function addCheckpointAt(state: GraphState, title: string, at: Point): Added {
  const nodeId = freshId('node', state.nodes.map((node) => node.id));
  const node: ExpeditionNode = { id: nodeId as ExpeditionNode['id'], kind: 'checkpoint', title, layout: at };
  return { state: { ...state, nodes: [...state.nodes, node] }, nodeId };
}

/**
 * Places a mission node, and the mission it holds.
 *
 * The mission starts from its type's defaults: settings, scoring and how it
 * is judged. Everything else about it is the property panel's (EXPD-027).
 */
function placeMission(
  state: GraphState,
  type: MissionTypeChoice,
  title: string,
  at: Point,
  flags: { secret?: boolean; boss?: boolean } = {},
): Added {
  const missionId = freshId('mission', state.missions.map((mission) => mission.id));
  const nodeId = freshId('node', state.nodes.map((node) => node.id));
  const mission = missionFrom(type, missionId, title);
  const node = {
    id: nodeId,
    kind: 'mission',
    title,
    missionInstanceId: missionId,
    layout: at,
    ...(flags.secret === true ? { secret: true } : {}),
    ...(flags.boss === true ? { boss: true } : {}),
  } as ExpeditionNode;
  return {
    state: { ...state, nodes: [...state.nodes, node], missions: [...state.missions, mission] },
    nodeId,
  };
}

/** A new mission of a type, as its type says it starts out. */
export function missionFrom(type: MissionTypeChoice, id: string, title: string): MissionInstance {
  const scoring = type.defaultScoring;
  return {
    id: id as MissionInstance['id'],
    missionTypeId: type.key,
    missionTypeVersion: type.version,
    title,
    // Shown on the mission board, and required. The type's own description is
    // a truthful start until the author writes one (EXPD-027).
    brief: type.description.trim() === '' ? title : type.description.trim(),
    config: structuredClone(type.defaultConfig),
    scoring: {
      basePoints: scoring.basePoints,
      allowPartialCredit: scoring.allowPartialCredit,
      ...(scoring.maxPoints === undefined ? {} : { maxPoints: scoring.maxPoints }),
    },
    attempts: { maxAttempts: null },
    verification: type.validationMethod,
    hints: [],
    media: [],
  };
}

const DEFAULT_TITLES: Record<'start' | 'checkpoint' | 'finish', string> = {
  start: 'Start',
  checkpoint: 'Checkpoint',
  finish: 'Finish',
};

/**
 * Somewhere to put a new node that is not on top of another one.
 *
 * To the right of `after` when there is one, otherwise below everything.
 */
export function freeSpot(state: GraphState, after?: string): Point {
  const anchor = after === undefined ? undefined : state.nodes.find((node) => node.id === after);
  let spot: Point;
  if (anchor !== undefined) {
    const from = positionOf(anchor);
    spot = { x: from.x + COLUMN, y: from.y };
  } else if (state.nodes.length === 0) {
    spot = { x: MARGIN, y: MARGIN };
  } else {
    const lowest = Math.max(...state.nodes.map((node) => positionOf(node).y));
    spot = { x: MARGIN, y: lowest + ROW };
  }
  while (state.nodes.some((node) => overlaps(positionOf(node), spot))) {
    spot = { x: spot.x, y: spot.y + ROW };
  }
  return spot;
}

function overlaps(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < NODE_WIDTH && Math.abs(a.y - b.y) < NODE_HEIGHT;
}

// --- Joining nodes ----------------------------------------------------------

/**
 * Why an edge from one node to another would not be allowed, or null.
 *
 * The same rules the schema holds a graph to (EXPD-002), asked before the
 * edge is drawn so the author is told at once rather than in the list.
 */
export function connectProblem(state: GraphState, from: string, to: string): string | null {
  const source = state.nodes.find((node) => node.id === from);
  const target = state.nodes.find((node) => node.id === to);
  if (source === undefined || target === undefined) {
    return 'That node is no longer there.';
  }
  if (from === to) {
    return 'A node cannot lead to itself.';
  }
  if (target.kind === 'start') {
    return 'Nothing may lead back into the start.';
  }
  if (source.kind === 'finish') {
    return 'Nothing may lead out of a finish.';
  }
  if (state.edges.some((edge) => edge.from === from && edge.to === to)) {
    return 'These two are already joined.';
  }
  if (reaches(state.edges, to, from)) {
    return 'That would make a loop, and no team could get past it.';
  }
  return null;
}

/** Joins two nodes, or says why not. */
export function connect(
  state: GraphState,
  from: string,
  to: string,
): { ok: true; state: GraphState } | { ok: false; reason: string } {
  const problem = connectProblem(state, from, to);
  return problem === null ? { ok: true, state: link(state, from, to) } : { ok: false, reason: problem };
}

function joinIfAllowed(state: GraphState, from: string | undefined, to: string): GraphState {
  return from !== undefined && connectProblem(state, from, to) === null ? link(state, from, to) : state;
}

function link(state: GraphState, from: string, to: string, label?: string): GraphState {
  const id = freshId('edge', state.edges.map((edge) => edge.id));
  const edge = { id, from, to, ...(label === undefined ? {} : { label }) } as ExpeditionEdge;
  return { ...state, edges: [...state.edges, edge] };
}

/** Whether `to` can be walked to from `from` along the edges. */
function reaches(edges: readonly ExpeditionEdge[], from: string, to: string): boolean {
  const seen = new Set<string>([from]);
  const queue = [from];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    if (current === to) {
      return true;
    }
    for (const edge of edges) {
      if (edge.from === current && !seen.has(edge.to)) {
        seen.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return false;
}

// --- Changing and removing --------------------------------------------------

export function moveNode(state: GraphState, nodeId: string, to: Point): GraphState {
  const at = { x: Math.max(0, Math.round(to.x)), y: Math.max(0, Math.round(to.y)) };
  return {
    ...state,
    nodes: state.nodes.map((node) => (node.id === nodeId ? { ...node, layout: at } : node)),
  };
}

/** Renames a node. The name is the author's; the mission's own title is not touched. */
export function renameNode(state: GraphState, nodeId: string, title: string): GraphState {
  return {
    ...state,
    nodes: state.nodes.map((node) => (node.id === nodeId ? { ...node, title } : node)),
  };
}

/** Turns `secret`, `boss` or `optional` on or off. Off leaves the field out, as the schema reads it. */
export function setMissionFlag(
  state: GraphState,
  nodeId: string,
  flag: 'secret' | 'boss' | 'optional',
  on: boolean,
): GraphState {
  return {
    ...state,
    nodes: state.nodes.map((node) => {
      if (node.id !== nodeId || node.kind !== 'mission') {
        return node;
      }
      const { [flag]: _dropped, ...rest } = node;
      return on ? { ...rest, [flag]: true } : rest;
    }) as ExpeditionNode[],
  };
}

export function setEdgeLabel(state: GraphState, edgeId: string, label: string): GraphState {
  return {
    ...state,
    edges: state.edges.map((edge) => {
      if (edge.id !== edgeId) {
        return edge;
      }
      const { label: _dropped, ...rest } = edge;
      return label === '' ? rest : { ...rest, label };
    }),
  };
}

/**
 * Removes a node, every edge touching it, and the mission it held.
 *
 * A condition or scoring rule elsewhere that named the mission is left as it
 * is; the check then says what points at a mission that is gone.
 */
export function removeNode(state: GraphState, nodeId: string): GraphState {
  const node = state.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) {
    return state;
  }
  const nodes = state.nodes.filter((candidate) => candidate.id !== nodeId);
  const missionId = node.kind === 'mission' ? node.missionInstanceId : undefined;
  const stillUsed = nodes.some((other) => other.kind === 'mission' && other.missionInstanceId === missionId);
  return {
    ...state,
    nodes,
    edges: state.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId),
    missions:
      missionId === undefined || stillUsed
        ? state.missions
        : state.missions.filter((mission) => mission.id !== missionId),
  };
}

export function removeEdge(state: GraphState, edgeId: string): GraphState {
  return { ...state, edges: state.edges.filter((edge) => edge.id !== edgeId) };
}

// --- What is wrong with it --------------------------------------------------

/** One problem, and the nodes and edges it is about. */
export interface GraphIssue extends ValidationIssue {
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
}

/**
 * Everything `validateExpeditionDefinition` says about the document, split
 * in two: problems with the graph and the missions on it, which are this
 * editor's to fix, and the rest (rules, scoring, metadata), which belong to
 * other screens.
 */
export function issuesOf(state: GraphState): {
  readonly graph: readonly GraphIssue[];
  readonly elsewhere: readonly ValidationIssue[];
} {
  const result = validateExpeditionDefinition(toDocument(state));
  if (result.valid) {
    return { graph: [], elsewhere: [] };
  }
  const graph: GraphIssue[] = [];
  const elsewhere: ValidationIssue[] = [];
  for (const issue of result.issues) {
    if (issue.path.startsWith('graph') || issue.path.startsWith('missions')) {
      graph.push({ ...issue, ...targetsOf(state, issue) });
    } else {
      elsewhere.push(issue);
    }
  }
  return { graph, elsewhere };
}

/** Which nodes and edges an issue is about, read off its path and message. */
function targetsOf(state: GraphState, issue: ValidationIssue): Pick<GraphIssue, 'nodeIds' | 'edgeIds'> {
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();

  const node = /^graph\.nodes\[(\d+)\]/.exec(issue.path);
  if (node !== null) {
    const found = state.nodes[Number(node[1])];
    if (found !== undefined) nodeIds.add(found.id);
  }
  const edge = /^graph\.edges\[(\d+)\]/.exec(issue.path);
  if (edge !== null) {
    const found = state.edges[Number(edge[1])];
    if (found !== undefined) edgeIds.add(found.id);
  }
  const mission = /^missions\[(\d+)\]/.exec(issue.path);
  if (mission !== null) {
    const missionId = state.missions[Number(mission[1])]?.id;
    for (const holder of state.nodes) {
      if (holder.kind === 'mission' && holder.missionInstanceId === missionId) nodeIds.add(holder.id);
    }
  }
  // "Node "x" cannot be reached", "loops back on itself at node "x"".
  const named = /[Nn]ode "([^"]+)"/.exec(issue.message);
  if (named !== null && state.nodes.some((candidate) => candidate.id === named[1])) {
    nodeIds.add(named[1] as string);
  }

  return { nodeIds: [...nodeIds], edgeIds: [...edgeIds] };
}

// --- Small pieces -----------------------------------------------------------

/** `prefix-1`, or the first number after it that is not taken. */
export function freshId(prefix: string, taken: readonly string[]): string {
  const used = new Set(taken);
  let n = 1;
  while (used.has(`${prefix}-${n}`)) {
    n += 1;
  }
  return `${prefix}-${n}`;
}

/**
 * Gives every node with no layout a place: one column per step from the
 * start, one row per node in that column. Nodes the start cannot reach go in
 * a column of their own at the end.
 */
function placeUnplaced(
  nodes: readonly ExpeditionNode[],
  edges: readonly ExpeditionEdge[],
): ExpeditionNode[] {
  if (nodes.every((node) => node.layout !== undefined)) {
    return [...nodes];
  }
  const depth = new Map<string, number>();
  const start = nodes.find((node) => node.kind === 'start');
  if (start !== undefined) {
    depth.set(start.id, 0);
    const queue = [start.id];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      const next = (depth.get(current) ?? 0) + 1;
      for (const edge of edges) {
        if (edge.from === current && !depth.has(edge.to)) {
          depth.set(edge.to, next);
          queue.push(edge.to);
        }
      }
    }
  }
  const lastColumn = Math.max(0, ...depth.values()) + 1;
  const rows = new Map<number, number>();
  return nodes.map((node) => {
    if (node.layout !== undefined) {
      return node;
    }
    const column = depth.get(node.id) ?? lastColumn;
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    return { ...node, layout: { x: MARGIN + column * COLUMN, y: MARGIN + row * ROW } };
  });
}

function asObject(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};
}

function asList<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value.filter((entry) => typeof entry === 'object' && entry !== null) as T[]) : [];
}

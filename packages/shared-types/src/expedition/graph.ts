/**
 * The shape of an expedition: what the stops are, and how they connect.
 *
 * A node is a stop. An edge is a way to get from one stop to the next. An edge
 * may carry a condition, which is the thing that has to be true before the
 * stop it points at opens up.
 *
 * This file describes those conditions, which stops a team may walk past
 * without finishing, which ones stay hidden until they open, and which teams
 * an edge is for. Working out what all of that comes to for one team is
 * progression work (EXPD-013), and drawing the graph is EXPD-026. Neither
 * belongs here.
 */

import type {
  EdgeId,
  MissionInstanceId,
  NodeId,
  RouteId,
  Seconds,
} from './common.ts';

/**
 * A test that has to pass before an edge may be taken.
 *
 * Conditions nest. `all-of`, `any-of` and `not` hold other conditions, so an
 * author can build up something like "finished the museum mission, and either
 * scored 50 points or has been playing for twenty minutes".
 */
export type UnlockCondition =
  /** Always true. The same as leaving the condition out. */
  | { type: 'always' }
  /** True once the given mission has been finished. */
  | { type: 'mission-completed'; missionInstanceId: MissionInstanceId }
  /** True once the given mission has been scored at or above `points`. */
  | {
      type: 'mission-score-at-least';
      missionInstanceId: MissionInstanceId;
      points: number;
    }
  /** True once the team's total is at or above `points`. */
  | { type: 'total-score-at-least'; points: number }
  /** True once at least `count` of the listed missions are finished. */
  | {
      type: 'missions-completed-at-least';
      count: number;
      /** The missions that count towards it. Must hold at least `count` ids. */
      missionInstanceIds: MissionInstanceId[];
    }
  /** True once this long has passed since the team started. */
  | { type: 'elapsed-time-at-least'; seconds: Seconds }
  /** True when every condition inside is true. An empty list is true. */
  | { type: 'all-of'; conditions: UnlockCondition[] }
  /** True when at least one condition inside is true. An empty list is false. */
  | { type: 'any-of'; conditions: UnlockCondition[] }
  /** True when the condition inside is false. */
  | { type: 'not'; condition: UnlockCondition };

/** The `type` of an unlock condition. */
export type UnlockConditionType = UnlockCondition['type'];

/** Every unlock condition type, in the order they are listed above. */
export const UNLOCK_CONDITION_TYPES = [
  'always',
  'mission-completed',
  'mission-score-at-least',
  'total-score-at-least',
  'missions-completed-at-least',
  'elapsed-time-at-least',
  'all-of',
  'any-of',
  'not',
] as const;

/**
 * Which teams an edge is for.
 *
 * An expedition may send two halves of a class different ways. Rather than
 * holding two graphs, one graph holds both, and each edge says who may take
 * it. A team walks the edges its route is named on, plus every edge that is
 * for everybody.
 *
 * The routes themselves are listed on the expedition's rules. Which route a
 * team is on is decided when teams are made (EXPD-018).
 */
export type EdgeAudience =
  /** Every team may take it. The same as leaving the audience out. */
  | { kind: 'all' }
  /**
   * Only teams on one of these routes may take it.
   *
   * Must name at least one route, and every route named must be listed in
   * `ExpeditionRules.routes`. An empty list would be an edge nobody can take,
   * which is a deleted edge written the long way round.
   */
  | { kind: 'routes'; routeIds: RouteId[] };

/** The `kind` of an edge audience. */
export type EdgeAudienceKind = EdgeAudience['kind'];

/** Every edge audience kind, in the order they are listed above. */
export const EDGE_AUDIENCE_KINDS = ['all', 'routes'] as const;

/** Where a node sits on the Studio canvas (EXPD-026). */
export interface NodeLayout {
  x: number;
  y: number;
}

/** The fields every node has, whatever its kind. */
interface NodeBase {
  id: NodeId;
  /** A name for the author. Students do not see it. */
  title: string;
  /** Where the node sits on the canvas. Has no effect on play. */
  layout?: NodeLayout;
  /** A note the author left for themselves. Students do not see it. */
  notes?: string;
}

/**
 * One stop in the expedition.
 *
 * Every node is a tagged object. A reader switches on `kind`.
 */
export type ExpeditionNode =
  /**
   * Where every team begins.
   *
   * An expedition has exactly one start node. It holds no mission, and no
   * edge may point at it.
   */
  | (NodeBase & { kind: 'start' })
  /** A stop that holds one mission. */
  | (NodeBase & {
      kind: 'mission';
      missionInstanceId: MissionInstanceId;
      /**
       * Whether a team may walk past it without finishing it.
       *
       * An optional mission never holds a team up: the stops after it open as
       * soon as the team arrives, whatever the team did about the mission
       * itself. Left out means the same as false, so a mission blocks the way
       * unless the author says otherwise.
       *
       * It is different from `ExpeditionRules.allowSkip`, which is about a
       * team choosing to give up on a mission that was in their way. This is
       * the author saying it was never in the way.
       */
      optional?: boolean;
      /**
       * Whether the team is told it exists before it opens.
       *
       * A secret mission is not on the mission board while it is locked: the
       * team does not see it, and does not see that something is missing.
       * Once its unlock condition holds it appears like any other mission,
       * and it stays visible from then on. Left out means the same as false.
       *
       * It changes what a team is shown, never what unlocks. A secret mission
       * with no condition in front of it is open from the start, and so is
       * visible from the start.
       */
      secret?: boolean;
    })
  /**
   * A stop that holds no mission.
   *
   * Use it to gather several paths back into one, or to split one path into
   * several. A team passes straight through it.
   */
  | (NodeBase & { kind: 'checkpoint' })
  /**
   * Where the expedition ends for a team.
   *
   * There is at least one. Reaching any of them finishes the expedition. No
   * edge may leave one.
   */
  | (NodeBase & { kind: 'finish'; message?: string });

/** The `kind` of a node. */
export type ExpeditionNodeKind = ExpeditionNode['kind'];

/** Every node kind, in the order they are listed above. */
export const EXPEDITION_NODE_KINDS = [
  'start',
  'mission',
  'checkpoint',
  'finish',
] as const;

/** A one-way link from one node to another. */
export interface ExpeditionEdge {
  id: EdgeId;
  /** The node the team is coming from. */
  from: NodeId;
  /** The node that opens up. */
  to: NodeId;
  /**
   * What has to be true before the edge may be taken.
   *
   * Left out means the same as `{ type: 'always' }`.
   */
  condition?: UnlockCondition;
  /**
   * Which teams may take it.
   *
   * Left out means the same as `{ kind: 'all' }`.
   */
  audience?: EdgeAudience;
  /** A label drawn on the edge in the Studio. Has no effect on play. */
  label?: string;
}

/** The stops and the links between them. */
export interface ExpeditionGraph {
  nodes: ExpeditionNode[];
  edges: ExpeditionEdge[];
}

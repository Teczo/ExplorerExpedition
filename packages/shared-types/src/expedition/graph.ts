/**
 * The shape of an expedition: what the stops are, and how they connect.
 *
 * A node is a stop. An edge is a way to get from one stop to the next. An edge
 * may carry a condition, which is the thing that has to be true before the
 * stop it points at opens up.
 *
 * This file describes those conditions. Working out whether one is true is
 * progression work (EXPD-013), and drawing the graph is EXPD-026. Neither
 * belongs here.
 */

import type {
  EdgeId,
  MissionInstanceId,
  NodeId,
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
  | (NodeBase & { kind: 'mission'; missionInstanceId: MissionInstanceId })
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
  /** A label drawn on the edge in the Studio. Has no effect on play. */
  label?: string;
}

/** The stops and the links between them. */
export interface ExpeditionGraph {
  nodes: ExpeditionNode[];
  edges: ExpeditionEdge[];
}

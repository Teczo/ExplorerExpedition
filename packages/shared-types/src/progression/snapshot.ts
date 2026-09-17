/**
 * What the expedition looks like to one team right now (EXPD-013).
 *
 * The graph (EXPD-002) says how an expedition is laid out for everybody. This
 * is what that lays out for *one* team: which stops they have got to, which
 * missions the lock is off, which ones they are shown at all, and what is
 * holding the rest up.
 *
 * It is here rather than in the engine for the reason every vocabulary before
 * it is: the mission board (EXPD-042) draws a locked mission from it, Director
 * Mode (EXPD-055) counts teams by where they are, and the realtime channel
 * (EXPD-023) sends one down the wire. None of those should need the engine to
 * read a word. The rules that work one out — which condition holds, which
 * stop a team may walk past, which edges their route lets them take — are in
 * `@explorer/engine`, because those are game rules.
 *
 * Everything here is a plain value that survives a round trip through JSON. A
 * snapshot is worked out again from scratch whenever something changes; it is
 * never edited in place, and nothing stores one.
 */

import type {
  EdgeId,
  MissionInstanceId,
  NodeId,
} from '../expedition/common.ts';
import type { ExpeditionNodeKind } from '../expedition/graph.ts';
import type { MissionState } from '../mission-state/states.ts';

/** Why one edge did not let a team through. */
export type ProgressionBlockReason =
  /** The stop the edge comes from has not been cleared yet. */
  | 'not-cleared'
  /** The edge's unlock condition does not hold yet. */
  | 'condition'
  /** The edge is for routes this team is not on. */
  | 'off-route';

/** Every reason an edge can be blocked, in the order they are listed above. */
export const PROGRESSION_BLOCK_REASONS = [
  'not-cleared',
  'condition',
  'off-route',
] as const satisfies readonly ProgressionBlockReason[];

/** One edge that leads to a stop, and why the team cannot come along it. */
export interface ProgressionBlocker {
  readonly edgeId: EdgeId;
  /** The stop the edge comes from. */
  readonly from: NodeId;
  readonly reason: ProgressionBlockReason;
}

/** Where one team stands at one stop. */
export interface ProgressionNode {
  readonly nodeId: NodeId;
  readonly kind: ExpeditionNodeKind;
  /**
   * Whether the team has got here.
   *
   * True for the start node always, and for any stop an edge has let the team
   * through to. A stop stays reached once it has been reached.
   */
  readonly reached: boolean;
  /**
   * Whether the stops after it may open.
   *
   * A start or a checkpoint is cleared the moment it is reached. A mission
   * stop is cleared once its mission has finished one way or another, or at
   * once when the author marked it optional.
   */
  readonly cleared: boolean;
  /**
   * Whether every edge leading here is for routes this team is not on.
   *
   * A stop on somebody else's route. The team will never reach it, and
   * nothing they do will change that.
   */
  readonly offRoute: boolean;
  /** Every edge leading here that did not let the team through, and why. */
  readonly blockedBy: readonly ProgressionBlocker[];
}

/** Where one team stands on one mission, as the graph sees it. */
export interface ProgressionMission {
  readonly missionInstanceId: MissionInstanceId;
  /** The stop that holds it. */
  readonly nodeId: NodeId;
  /**
   * Where the mission itself stands (EXPD-010).
   *
   * `locked` when the team has no record of it yet, which is what a mission
   * they have not got to looks like.
   */
  readonly state: MissionState;
  /** Whether the team has got to the stop that holds it. */
  readonly reached: boolean;
  /**
   * Whether the lock is off.
   *
   * The team has got to the stop and, in `strict`, it is this mission's turn.
   * It stays true once the mission has been finished, because a finished
   * mission is not a locked one.
   *
   * It does not say the team may press start this second: how many tries are
   * left, whether a cooldown is running and whether a submission is waiting
   * on a teacher are the mission state machine's (EXPD-010).
   */
  readonly unlocked: boolean;
  /**
   * Whether the team is shown it at all.
   *
   * True for every mission that is not secret, whatever state it is in, so
   * that a board can draw a locked mission with a lock on it. A secret
   * mission is false until the team reaches it, and true from then on.
   */
  readonly visible: boolean;
  /** Whether the team may walk past it without finishing it. */
  readonly optional: boolean;
  /** Whether the team was kept from knowing it existed. */
  readonly secret: boolean;
  /** Whether it sits on a route this team is not on. */
  readonly offRoute: boolean;
  /** What is holding it up, the same list its stop carries. */
  readonly blockedBy: readonly ProgressionBlocker[];
}

/** What the whole expedition comes to for one team. */
export interface ProgressionSnapshot {
  /** Every stop in the expedition, in the order the document lists them. */
  readonly nodes: readonly ProgressionNode[];
  /** Every mission placed on a stop, in the order the document lists them. */
  readonly missions: readonly ProgressionMission[];
  /** The missions the lock is off for, in the order the document lists them. */
  readonly unlockedMissionIds: readonly MissionInstanceId[];
  /** The missions the team is shown, open or not. */
  readonly visibleMissionIds: readonly MissionInstanceId[];
  /** The finish nodes the team has reached. */
  readonly reachedFinishNodeIds: readonly NodeId[];
  /**
   * Whether the team has reached a finish node.
   *
   * Reaching one finishes the expedition for that team. What that does to the
   * run as a whole is the session's (EXPD-019), because `EndMode` may say
   * everybody waits for the last team.
   */
  readonly finished: boolean;
}

/** Finds one mission in a snapshot, or `undefined` when it holds no such mission. */
export function progressionMissionOf(
  snapshot: ProgressionSnapshot,
  missionInstanceId: MissionInstanceId,
): ProgressionMission | undefined {
  return snapshot.missions.find(
    (mission) => mission.missionInstanceId === missionInstanceId,
  );
}

/** Finds one stop in a snapshot, or `undefined` when it holds no such stop. */
export function progressionNodeOf(
  snapshot: ProgressionSnapshot,
  nodeId: NodeId,
): ProgressionNode | undefined {
  return snapshot.nodes.find((node) => node.nodeId === nodeId);
}

/**
 * Says whether the lock is off one mission for this team.
 *
 * A mission the snapshot does not hold is locked, because a team cannot work
 * on something this expedition does not place anywhere.
 */
export function isMissionUnlocked(
  snapshot: ProgressionSnapshot,
  missionInstanceId: MissionInstanceId,
): boolean {
  return progressionMissionOf(snapshot, missionInstanceId)?.unlocked === true;
}

/** Says whether the team is shown one mission. */
export function isMissionVisible(
  snapshot: ProgressionSnapshot,
  missionInstanceId: MissionInstanceId,
): boolean {
  return progressionMissionOf(snapshot, missionInstanceId)?.visible === true;
}

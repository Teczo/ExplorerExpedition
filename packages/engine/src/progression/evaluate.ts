/**
 * Progression and unlock evaluation (EXPD-013).
 *
 * The graph says how the expedition is laid out for everybody. This says what
 * it comes to for one team: where they have got to, which missions the lock
 * is off, which ones they are shown at all, and what is holding the rest up.
 *
 * ```ts
 * const snapshot = evaluateProgression({
 *   policy: progressionPolicyFor(definition),
 *   situation: teamSituation({
 *     missions: progressByMission,   // where EXPD-010 says the team stands
 *     score,                         // and what EXPD-012 says they have earned
 *     elapsedSeconds,                // the session's clock (EXPD-019)
 *     routeIds: team.routeIds,       // the route the team was put on
 *   }),
 * });
 *
 * snapshot.unlockedMissionIds;       // what the board may offer
 * snapshot.visibleMissionIds;        // what the board may show at all
 * snapshot.finished;                 // whether they have reached a finish
 * ```
 *
 * **A team walks the graph; the engine does not push them along it.** The
 * whole answer is worked out from where the team stands, every time it is
 * asked. Nothing is remembered between calls, so a snapshot cannot drift from
 * the records behind it, and a team rebuilt from stored rows (EXPD-020) lands
 * on exactly the snapshot they had.
 *
 * **Reaching a stop and clearing it are two different things.** A team
 * reaches a stop when an edge lets them through to it. They clear it when
 * they have done what it asks, which is what lets the stops after it open. A
 * start or a checkpoint is cleared the moment it is reached. A mission stop
 * is cleared when its mission is over — finished, failed or skipped — or at
 * once when the author marked it optional.
 *
 * **A mission that is over never blocks the way, however it ended.** A team
 * with no tries left on a puzzle has finished with that puzzle, and an
 * expedition that left them standing in front of it for the rest of the
 * afternoon would be a bug rather than a rule. But only a mission that was
 * `complete` counts towards a `mission-completed` condition, so giving up on
 * one never unlocks what finishing it would have.
 *
 * **What it does not do.** It does not move a mission's state: that is the
 * state machine (EXPD-010), and this reads what that decided. It does not
 * judge work (EXPD-011) or award points (EXPD-012). It does not hold a clock:
 * how long the team has been playing arrives on the situation. And it does
 * not decide which route a team is on — that is EXPD-018 — only what being on
 * one lets them see.
 */

import {
  isTerminalMissionState,
  type ExpeditionEdge,
  type ExpeditionNode,
  type MissionInstanceId,
  type NodeId,
  type ProgressionBlocker,
  type ProgressionMission,
  type ProgressionNode,
  type ProgressionSnapshot,
} from '@explorer/shared-types';

import { evaluateUnlockCondition } from './conditions.ts';
import { DEFAULT_PROGRESSION_POLICY, type ProgressionPolicy } from './policy.ts';
import { audienceCoversTeam } from './routes.ts';
import {
  EMPTY_TEAM_SITUATION,
  missionStateIn,
  type TeamSituation,
} from './situation.ts';

/** One team, one expedition, one question. */
export interface ProgressionRequest {
  /** What the definition says. Defaults to an expedition with no stops. */
  readonly policy?: ProgressionPolicy;
  /** What the team has done. Defaults to a team that has done nothing. */
  readonly situation?: TeamSituation;
}

/** What a mission stop says about the mission on it. */
interface MissionPlacement {
  readonly node: ExpeditionNode & { kind: 'mission' };
  readonly optional: boolean;
  readonly secret: boolean;
}

/** The mission a stop holds, when it holds one. */
function missionPlacementOf(node: ExpeditionNode): MissionPlacement | undefined {
  if (node.kind !== 'mission') {
    return undefined;
  }
  return {
    node,
    optional: node.optional === true,
    secret: node.secret === true,
  };
}

/**
 * Works out what the expedition comes to for one team.
 *
 * The one entry point. What comes back is a whole picture of the expedition
 * for that team, worked out from nothing but the policy and the situation.
 */
export function evaluateProgression(
  request: ProgressionRequest = {},
): ProgressionSnapshot {
  const policy = request.policy ?? DEFAULT_PROGRESSION_POLICY;
  const situation = request.situation ?? EMPTY_TEAM_SITUATION;

  const nodes = policy.graph.nodes ?? [];
  const nodeIds = new Set<NodeId>(nodes.map((node) => node.id));

  // An edge with an end that is not in this document is not an edge. The
  // validator turns such a document away; the engine drops the edge rather
  // than reading a stop that is not there.
  const edges = (policy.graph.edges ?? []).filter(
    (edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to),
  );

  const incoming = new Map<NodeId, ExpeditionEdge[]>();
  for (const edge of edges) {
    const already = incoming.get(edge.to);
    if (already === undefined) {
      incoming.set(edge.to, [edge]);
    } else {
      already.push(edge);
    }
  }

  /** Whether this team's route lets them take an edge. */
  const onRoute = (edge: ExpeditionEdge): boolean =>
    audienceCoversTeam(edge.audience, situation.routeIds);

  /** Whether the edge's condition holds for this team. */
  const conditionHolds = (edge: ExpeditionEdge): boolean =>
    evaluateUnlockCondition(edge.condition, situation);

  /** Whether the team has done what a stop asks, so the stops after it open. */
  const clearsStop = (node: ExpeditionNode): boolean => {
    const placement = missionPlacementOf(node);
    if (placement === undefined) {
      // A start, a checkpoint or a finish asks nothing of a team beyond
      // arriving at it.
      return true;
    }
    if (placement.optional) {
      return true;
    }
    return isTerminalMissionState(
      missionStateIn(situation, placement.node.missionInstanceId),
    );
  };

  const freeRoam = policy.mode === 'free-roam';
  const reached = new Set<NodeId>();
  const cleared = new Set<NodeId>();

  if (freeRoam) {
    // `free-roam` says every mission is open from the start and that edges
    // and their conditions are ignored, so every stop is reached and there is
    // nothing to be blocked by. A route is carried on an edge, so ignoring
    // edges ignores routes with them, and a secret mission has nothing left
    // to hide behind. An author who wants either of those wants `open`.
    for (const node of nodes) {
      reached.add(node.id);
      if (clearsStop(node)) {
        cleared.add(node.id);
      }
    }
  } else {
    const start = nodes.find((node) => node.kind === 'start');
    if (start !== undefined) {
      reached.add(start.id);
    }

    // Walking outwards until nothing more opens. Every pass that changes
    // anything adds a stop to one of the two sets and neither ever shrinks,
    // so this ends however the graph is drawn — a document with a loop in it
    // included, which the validator turns away but the engine still has to
    // survive being handed.
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of nodes) {
        if (!reached.has(node.id) || cleared.has(node.id)) {
          continue;
        }
        if (clearsStop(node)) {
          cleared.add(node.id);
          changed = true;
        }
      }
      for (const edge of edges) {
        if (!cleared.has(edge.from) || reached.has(edge.to)) {
          continue;
        }
        if (onRoute(edge) && conditionHolds(edge)) {
          reached.add(edge.to);
          changed = true;
        }
      }
    }
  }

  /**
   * In `strict` a team works through the missions one at a time, so the only
   * required mission with the lock off is the first one they have reached and
   * not finished. Document order is what "first" means: it is the order the
   * author laid the stops out in, and it is the same for every team and every
   * replay. An optional mission is not in this queue at all — a side quest
   * that held up the main line would be holding the team up, which is the one
   * thing optional says it never does.
   */
  const firstOutstandingRequired = nodes.find((node) => {
    const placement = missionPlacementOf(node);
    if (placement === undefined || placement.optional) {
      return false;
    }
    if (!reached.has(node.id)) {
      return false;
    }
    return !isTerminalMissionState(
      missionStateIn(situation, placement.node.missionInstanceId),
    );
  })?.id;

  const blockersOf = (node: ExpeditionNode): ProgressionBlocker[] => {
    if (freeRoam) {
      return [];
    }
    const blockers: ProgressionBlocker[] = [];
    for (const edge of incoming.get(node.id) ?? []) {
      if (!onRoute(edge)) {
        // Being on somebody else's route is not something the team can play
        // their way out of, so it is said first and said on its own.
        blockers.push({ edgeId: edge.id, from: edge.from, reason: 'off-route' });
        continue;
      }
      if (!cleared.has(edge.from)) {
        blockers.push({ edgeId: edge.id, from: edge.from, reason: 'not-cleared' });
        continue;
      }
      if (!conditionHolds(edge)) {
        blockers.push({ edgeId: edge.id, from: edge.from, reason: 'condition' });
      }
    }
    return blockers;
  };

  const offRouteAt = (node: ExpeditionNode): boolean => {
    if (freeRoam) {
      return false;
    }
    const leadingHere = incoming.get(node.id) ?? [];
    if (leadingHere.length === 0) {
      return false;
    }
    return leadingHere.every((edge) => !onRoute(edge));
  };

  const snapshotNodes: ProgressionNode[] = nodes.map((node) => ({
    nodeId: node.id,
    kind: node.kind,
    reached: reached.has(node.id),
    cleared: cleared.has(node.id),
    offRoute: offRouteAt(node),
    blockedBy: blockersOf(node),
  }));

  const missions: ProgressionMission[] = [];
  const unlockedMissionIds: MissionInstanceId[] = [];
  const visibleMissionIds: MissionInstanceId[] = [];

  nodes.forEach((node, index) => {
    const placement = missionPlacementOf(node);
    if (placement === undefined) {
      return;
    }
    const missionInstanceId = placement.node.missionInstanceId;
    const state = missionStateIn(situation, missionInstanceId);
    const here = snapshotNodes[index];
    const isReached = here?.reached === true;

    const unlocked =
      isReached &&
      (policy.mode !== 'strict' ||
        placement.optional ||
        isTerminalMissionState(state) ||
        firstOutstandingRequired === node.id);

    // A mission nobody was told about appears the moment its team gets to it,
    // and stays. Every other mission is on the board from the start, locked
    // until it is not, because a board that hides what is coming is a board a
    // team cannot plan against.
    const visible = !placement.secret || isReached;

    missions.push({
      missionInstanceId,
      nodeId: node.id,
      state,
      reached: isReached,
      unlocked,
      visible,
      optional: placement.optional,
      secret: placement.secret,
      offRoute: here?.offRoute === true,
      blockedBy: here?.blockedBy ?? [],
    });
    if (unlocked) {
      unlockedMissionIds.push(missionInstanceId);
    }
    if (visible) {
      visibleMissionIds.push(missionInstanceId);
    }
  });

  const reachedFinishNodeIds = nodes
    .filter((node) => node.kind === 'finish' && reached.has(node.id))
    .map((node) => node.id);

  return {
    nodes: snapshotNodes,
    missions,
    unlockedMissionIds,
    visibleMissionIds,
    reachedFinishNodeIds,
    finished: reachedFinishNodeIds.length > 0,
  };
}

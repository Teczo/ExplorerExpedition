/**
 * What stands in front of a mission (EXPD-013).
 *
 * Evaluating progression answers the question for one team at one moment.
 * This answers it about the document itself, with no team in it: what would
 * anybody have to finish before this mission could open?
 *
 * Two things put a mission in front of another. The graph does, when the stop
 * before it holds a mission the team has to clear. A condition does, when it
 * names a mission by id. Both are dependencies, and an author looking at
 * their own expedition (EXPD-029) or a student asking why a mission is locked
 * (EXPD-042) means both.
 *
 * **It is one step back, not the whole way.** What comes back is what stands
 * immediately in front of the mission, not everything that has to happen
 * first. Walking the whole way back to the start is a different question with
 * a different answer on every branch, and the one place it is worth asking —
 * can this expedition actually be finished — is the simulation harness's
 * (EXPD-015).
 */

import {
  MAX_UNLOCK_CONDITION_DEPTH,
  type ExpeditionNode,
  type MissionInstanceId,
  type UnlockCondition,
} from '@explorer/shared-types';

import type { ProgressionPolicy } from './policy.ts';

/**
 * Every mission a condition names, however deeply it is nested.
 *
 * In document order, with each mission named once. A mission inside a `not`
 * is in the list: it is still a mission this condition is about, and a caller
 * drawing the dependencies of an expedition wants the line drawn. What the
 * condition does with it is `evaluateUnlockCondition`'s business.
 */
export function missionsNamedByCondition(
  condition: UnlockCondition | undefined,
): readonly MissionInstanceId[] {
  const found: MissionInstanceId[] = [];
  const seen = new Set<MissionInstanceId>();

  const add = (missionInstanceId: MissionInstanceId): void => {
    if (seen.has(missionInstanceId)) {
      return;
    }
    seen.add(missionInstanceId);
    found.push(missionInstanceId);
  };

  const walk = (inner: UnlockCondition | undefined, depth: number): void => {
    if (inner === undefined || depth > MAX_UNLOCK_CONDITION_DEPTH) {
      return;
    }
    switch (inner.type) {
      case 'mission-completed':
      case 'mission-score-at-least':
        add(inner.missionInstanceId);
        break;
      case 'missions-completed-at-least':
        inner.missionInstanceIds.forEach(add);
        break;
      case 'all-of':
      case 'any-of':
        inner.conditions.forEach((nested) => {
          walk(nested, depth + 1);
        });
        break;
      case 'not':
        walk(inner.condition, depth + 1);
        break;
      case 'always':
      case 'total-score-at-least':
      case 'elapsed-time-at-least':
        break;
    }
  };

  walk(condition, 1);
  return found;
}

/** The stop that holds one mission, when the expedition places it anywhere. */
export function nodeHoldingMission(
  policy: ProgressionPolicy,
  missionInstanceId: MissionInstanceId,
): ExpeditionNode | undefined {
  return (policy.graph.nodes ?? []).find(
    (node) => node.kind === 'mission' && node.missionInstanceId === missionInstanceId,
  );
}

/**
 * The missions that stand immediately in front of one mission.
 *
 * In document order, each named once. Two kinds of thing land here: the
 * mission on a stop that leads straight to this one, and every mission named
 * by a condition on an edge leading here.
 *
 * A mission on an optional stop is not one of them. Optional means a team may
 * walk past it, so it never stands in front of anything — even though a
 * condition naming it still does.
 *
 * A mission this expedition does not place anywhere has nothing in front of
 * it, because there is nothing to be in front of.
 */
export function missionsRequiredBefore(
  policy: ProgressionPolicy,
  missionInstanceId: MissionInstanceId,
): readonly MissionInstanceId[] {
  const node = nodeHoldingMission(policy, missionInstanceId);
  if (node === undefined) {
    return [];
  }

  const byId = new Map(
    (policy.graph.nodes ?? []).map((entry) => [entry.id, entry] as const),
  );
  const found: MissionInstanceId[] = [];
  const seen = new Set<MissionInstanceId>([missionInstanceId]);

  const add = (id: MissionInstanceId): void => {
    if (seen.has(id)) {
      return;
    }
    seen.add(id);
    found.push(id);
  };

  for (const edge of policy.graph.edges ?? []) {
    if (edge.to !== node.id) {
      continue;
    }
    const from = byId.get(edge.from);
    if (from !== undefined && from.kind === 'mission' && from.optional !== true) {
      add(from.missionInstanceId);
    }
    missionsNamedByCondition(edge.condition).forEach(add);
  }

  return found;
}

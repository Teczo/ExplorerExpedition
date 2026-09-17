/**
 * Whether one unlock condition holds for one team (EXPD-013).
 *
 * An edge may carry a condition, and the condition is the thing that has to
 * be true before the stop it points at opens up. The schema (EXPD-002)
 * describes six tests and three ways of combining them; this works out what
 * they come to, given what the engine has been told about the team.
 *
 * **Finished means finished, not over.** `mission-completed` holds when the
 * mission is `complete` and at no other time. A mission a team failed or
 * skipped is over, and the team may walk on past it — that is what clearing a
 * stop means in `evaluate.ts` — but it never counts as one they finished.
 * Otherwise a team could unlock the reward for a puzzle by giving up on it.
 *
 * **An empty list keeps the meaning the schema gives it.** `all-of` with
 * nothing in it is true, because every one of no conditions holds. `any-of`
 * with nothing in it is false, because none of no conditions does. Both are
 * what the schema says, and both are what a Studio canvas with an empty group
 * on it should come to.
 */

import {
  MAX_UNLOCK_CONDITION_DEPTH,
  type UnlockCondition,
} from '@explorer/shared-types';

import {
  missionPointsIn,
  missionStateIn,
  type TeamSituation,
} from './situation.ts';

/**
 * Says whether a condition holds for this team.
 *
 * A condition nested deeper than the schema allows does not hold. A document
 * that deep would have been turned away by `validateExpeditionDefinition`
 * before it was ever played, so this is the engine refusing to walk a
 * structure nobody should have been able to save rather than a rule of the
 * game. Refusing keeps the stop shut, which is the safe way round.
 */
export function evaluateUnlockCondition(
  condition: UnlockCondition | undefined,
  situation: TeamSituation,
  depth = 1,
): boolean {
  // An edge with no condition is an edge anybody may take, which is what the
  // schema says leaving it out means.
  if (condition === undefined) {
    return true;
  }
  if (depth > MAX_UNLOCK_CONDITION_DEPTH) {
    return false;
  }

  switch (condition.type) {
    case 'always':
      return true;

    case 'mission-completed':
      return missionStateIn(situation, condition.missionInstanceId) === 'complete';

    case 'mission-score-at-least':
      return missionPointsIn(situation, condition.missionInstanceId) >= condition.points;

    case 'total-score-at-least':
      return situation.totalPoints >= condition.points;

    case 'missions-completed-at-least': {
      // The same mission listed twice is one mission finished, not two, so
      // that a duplicate in the document cannot open a stop early.
      const finished = new Set(
        condition.missionInstanceIds.filter(
          (id) => missionStateIn(situation, id) === 'complete',
        ),
      );
      return finished.size >= condition.count;
    }

    case 'elapsed-time-at-least':
      return situation.elapsedSeconds >= condition.seconds;

    case 'all-of':
      return condition.conditions.every((inner) =>
        evaluateUnlockCondition(inner, situation, depth + 1),
      );

    case 'any-of':
      return condition.conditions.some((inner) =>
        evaluateUnlockCondition(inner, situation, depth + 1),
      );

    case 'not':
      return !evaluateUnlockCondition(condition.condition, situation, depth + 1);
  }
}

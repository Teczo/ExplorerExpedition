/**
 * Reading a run back as advice (EXPD-015).
 *
 * A report full of per-team detail answers a test's question and not an
 * author's. An author — or the AI builder checking its own work (EXPD-066) —
 * wants the short list: what about this expedition would go wrong on the day,
 * worst first.
 *
 * Every finding is drawn from what the teams actually did. Nothing here
 * inspects the document for a shape it dislikes; that is
 * `validateExpeditionDefinition` (EXPD-002) and the registry's own check
 * (EXPD-009), both of which run before a document is ever played. What a run
 * can say that neither of those can is that a mission was reachable on paper
 * and nobody got to it, that an expedition can be started and not finished,
 * or that an afternoon of it runs past the end of the school day.
 *
 * **A finding is evidence, not a proof.** It is about the teams that played
 * and the dials they played with, and the wording says so. Three middling
 * teams failing to finish is worth reporting and is not the same as proving
 * nobody could.
 */

import type { ExpeditionNode, MissionInstanceId, NodeId } from '@explorer/shared-types';

import type { SimulationPlan } from './plan.ts';
import type {
  SimulatedTeamResult,
  SimulationFinding,
  SimulationFindingSeverity,
} from './report.ts';

/** The order findings come back in. */
const SEVERITY_ORDER: Record<SimulationFindingSeverity, number> = {
  error: 0,
  warning: 1,
  note: 2,
};

/** How a mission is named in a sentence an author reads. */
function nameOf(plan: SimulationPlan, missionInstanceId: MissionInstanceId): string {
  const planned = plan.missionsById.get(missionInstanceId);
  const title = planned?.mission.title;
  return title === undefined || title.trim() === '' ? String(missionInstanceId) : title;
}

/** How a stop is named, likewise. */
function nodeNameOf(node: ExpeditionNode): string {
  return node.title.trim() === '' ? String(node.id) : node.title;
}

/**
 * Everything one run found, worst first.
 *
 * Errors are things that stop the expedition being played as written,
 * warnings are things that probably are not what the author meant, and notes
 * are about the run rather than about the expedition.
 */
export function findingsFor(
  plan: SimulationPlan,
  teams: readonly SimulatedTeamResult[],
): readonly SimulationFinding[] {
  const found: SimulationFinding[] = [];
  const nodes = plan.definition.graph?.nodes ?? [];
  const freeRoam = plan.progression.mode === 'free-roam';

  // The two stops an expedition cannot do without. In `free-roam` every
  // mission is open from the start, so a missing start holds nobody up — but
  // there is still nowhere to end.
  if (!freeRoam && !nodes.some((node) => node.kind === 'start')) {
    found.push({
      code: 'no-start-node',
      severity: 'error',
      message: 'This expedition has no start, so no team can begin it.',
    });
  }
  if (!nodes.some((node) => node.kind === 'finish')) {
    found.push({
      code: 'no-finish-node',
      severity: 'error',
      message: 'This expedition has no finish, so no team can complete it.',
    });
  }

  for (const ref of plan.unusableTypeRefs) {
    found.push({
      code: 'unknown-mission-type',
      severity: 'error',
      missionTypeRef: ref,
      message:
        `No mission type could be built for "${ref}". A key is lower-case ` +
        'words joined by single hyphens, and a version is three ' +
        'dot-separated whole numbers.',
    });
  }

  if (teams.length > 0 && !teams.some((team) => team.finished)) {
    found.push({
      code: 'no-team-finished',
      severity: 'error',
      message:
        `Not one of the ${String(teams.length)} simulated teams reached a ` +
        'finish. Something in the expedition is stopping every team.',
    });
  }

  for (const team of teams) {
    if (team.stop === 'stuck' && !team.finished) {
      found.push({
        code: 'team-stuck',
        severity: 'warning',
        teamId: team.teamId,
        message:
          `${team.teamId} ran out of missions they were allowed to play ` +
          'before reaching a finish.',
      });
    }
    if (team.stop === 'step-budget') {
      found.push({
        code: 'step-budget-spent',
        severity: 'note',
        teamId: team.teamId,
        message:
          `${team.teamId} was still playing when the run gave up counting. ` +
          'Something in this expedition can be repeated without end.',
      });
    }
    if (team.stop === 'time-budget') {
      found.push({
        code: 'time-budget-spent',
        severity: 'note',
        teamId: team.teamId,
        message: `${team.teamId} was still playing after the run's time limit.`,
      });
    }
  }

  found.push(...missionFindings(plan, teams));
  found.push(...nodeFindings(teams, nodes));
  found.push(...refusalFindings(plan, teams));
  found.push(...samplingFindings(plan));

  return found.sort(
    (left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity],
  );
}

/** What the run found about the missions themselves. */
function missionFindings(
  plan: SimulationPlan,
  teams: readonly SimulatedTeamResult[],
): SimulationFinding[] {
  if (teams.length === 0) {
    return [];
  }
  const found: SimulationFinding[] = [];
  // An expedition with routes in it sends different teams different ways on
  // purpose, so a mission nobody walked past may simply be somebody else's
  // path rather than a mistake.
  const hasRoutes = plan.progression.routeIds.length > 0;
  // A run only proves something about the graph once somebody walked it to
  // the end. Teams that gave up half way never got near the far side of the
  // expedition, and calling that an unreachable mission would send an author
  // looking for a broken edge that is not there.
  const someoneFinished = teams.some((team) => team.finished);
  const provesReachability = someoneFinished && !hasRoutes;

  for (const planned of plan.missions) {
    const missionInstanceId = planned.mission.id;
    const reachedBy = teams.filter(
      (team) => !team.unreachedMissionIds.includes(missionInstanceId),
    );
    const completedBy = teams.filter((team) =>
      team.completedMissionIds.includes(missionInstanceId),
    );

    if (reachedBy.length === 0) {
      found.push({
        code: 'mission-never-reached',
        severity: provesReachability ? 'error' : 'warning',
        missionInstanceId,
        ...(planned.nodeId === undefined ? {} : { nodeId: planned.nodeId }),
        message:
          `No simulated team ever got to "${nameOf(plan, missionInstanceId)}". ` +
          (provesReachability
            ? 'Teams finished the expedition without it, so nothing in the ' +
              'graph opens the way to it.'
            : hasRoutes
              ? 'Check the routes its edges are for.'
              : 'No team got that far, so this may be how the run ended ' +
                'rather than how the graph is drawn.'),
      });
      continue;
    }

    if (completedBy.length === 0) {
      found.push({
        code: 'mission-never-completed',
        severity: 'warning',
        missionInstanceId,
        ...(planned.nodeId === undefined ? {} : { nodeId: planned.nodeId }),
        message:
          `Teams got to "${nameOf(plan, missionInstanceId)}" and not one of ` +
          'them finished it. It may be too hard, too short on tries, or too ' +
          'tightly timed.',
      });
    }
  }

  return found;
}

/** What the run found about the stops nobody stood on. */
function nodeFindings(
  teams: readonly SimulatedTeamResult[],
  nodes: readonly ExpeditionNode[],
): SimulationFinding[] {
  if (teams.length === 0) {
    return [];
  }
  const reached = new Set<NodeId>();
  for (const team of teams) {
    for (const node of team.snapshot.nodes) {
      if (node.reached) {
        reached.add(node.nodeId);
      }
    }
  }

  return nodes
    // A mission stop nobody reached is already reported as a mission, and
    // saying it twice would be two problems about one mistake.
    .filter((node) => node.kind !== 'mission' && !reached.has(node.id))
    .map((node) => ({
      code: 'node-never-reached' as const,
      severity: 'warning' as const,
      nodeId: node.id,
      message: `No simulated team ever reached "${nodeNameOf(node)}".`,
    }));
}

/** What the engine refused during the run, said once per kind of refusal. */
function refusalFindings(
  plan: SimulationPlan,
  teams: readonly SimulatedTeamResult[],
): SimulationFinding[] {
  const found: SimulationFinding[] = [];
  const said = new Set<string>();

  for (const team of teams) {
    for (const refusal of team.refusals) {
      if (refusal.from !== 'completion') {
        continue;
      }
      // `not-now` is the engine saying the mission had already moved on,
      // which is a race a real run has and not a fault in the document.
      if (refusal.code === 'not-now') {
        continue;
      }
      const key = `${refusal.code}:${String(refusal.missionInstanceId ?? '')}`;
      if (said.has(key)) {
        continue;
      }
      said.add(key);

      const unknownType = refusal.code === 'unknown-mission-type';
      // The type has already been reported on its own, and one mistake gets
      // one finding.
      if (
        unknownType &&
        plan.unusableTypeRefs.includes(refTypeOf(plan, refusal.missionInstanceId))
      ) {
        continue;
      }
      found.push({
        code: unknownType ? 'unknown-mission-type' : 'submission-refused',
        severity: unknownType ? 'error' : 'warning',
        ...(refusal.missionInstanceId === undefined
          ? {}
          : { missionInstanceId: refusal.missionInstanceId }),
        message:
          refusal.missionInstanceId === undefined
            ? refusal.message
            : `"${nameOf(plan, refusal.missionInstanceId)}" could not be played: ${refusal.message}`,
      });
    }
  }

  return found;
}

/** The `key@version` of the mission a refusal was about, when it was about one. */
function refTypeOf(
  plan: SimulationPlan,
  missionInstanceId: MissionInstanceId | undefined,
): string {
  if (missionInstanceId === undefined) {
    return '';
  }
  return plan.missionsById.get(missionInstanceId)?.ref ?? '';
}

/** Which mission types were played against a payload built from their schema. */
function samplingFindings(plan: SimulationPlan): SimulationFinding[] {
  const refs = new Set<string>();
  for (const planned of plan.missions) {
    if (planned.sampled) {
      refs.add(planned.ref);
    }
  }
  return [...refs].sort().map((ref) => ({
    code: 'sampled-mission-type' as const,
    severity: 'note' as const,
    missionTypeRef: ref,
    message:
      `Nothing was registered to play "${ref}", so the teams handed in a ` +
      'payload built from its own submission schema. What this run says ' +
      'about those missions is about the harness rather than the expedition.',
  }));
}

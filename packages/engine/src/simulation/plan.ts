/**
 * What a run is told before it starts (EXPD-015).
 *
 * The harness reads one expedition document and asks the same four policy
 * readers every other part of the engine asks — the state machine's
 * (EXPD-010), the completion interface's (EXPD-011), the scoring engine's
 * (EXPD-012) and progression's (EXPD-013). It reads them **once**, here,
 * rather than once per attempt, for the reason EXPD-009 gives about
 * `prepare`: a run is thousands of attempts, and reading a mission's settings
 * out of a document on each of them is work nobody asked for.
 *
 * Everything the run needs is gathered into one value, so the loop in
 * `run.ts` is about playing and never about digging a setting out of a
 * document.
 *
 * **Nothing here decides anything about the game.** It is the request with
 * its defaults filled in and its policies read. Turning a plan into a run is
 * `run.ts`.
 */

import {
  missionTypeRef,
  type ExpeditionDefinition,
  type IsoTimestamp,
  type MissionInstance,
  type MissionInstanceId,
  type NodeId,
  type RouteId,
  type Seconds,
} from '@explorer/shared-types';

import {
  missionCompletionPolicyFor,
  type MissionCompletionPolicy,
} from '../completion/policy.ts';
import { missionStatePolicyFor, type MissionStatePolicy } from '../mission-state/policy.ts';
import type { MissionTypeRegistry } from '../mission-types/registry.ts';
import { progressionPolicyFor, type ProgressionPolicy } from '../progression/policy.ts';
import {
  expeditionScoringPolicyFor,
  missionScoringPolicyFor,
  type ExpeditionScoringPolicy,
  type MissionScoringPolicy,
} from '../scoring/policy.ts';
import { DEFAULT_SIMULATION_START } from './clock.ts';
import { samplingPlayer, type SimulatedPlayer } from './players.ts';
import type { SimulationJudging } from './report.ts';
import { scriptedPlayer, scriptedRegistryFor } from './scripted.ts';
import { simulatedTeams, type SimulatedTeam } from './teams.ts';

/** Where a run gives up, so that a broken document cannot hang a caller. */
export interface SimulationLimits {
  /**
   * The most actions one team may take.
   *
   * An action is one thing the team does: opening a mission, handing work in,
   * waiting on a teacher. A team that keeps failing a mission with unlimited
   * tries would otherwise never stop.
   */
  readonly maxStepsPerTeam: number;
  /**
   * The most simulated seconds one team may play for.
   *
   * Eight hours by default: longer than any school day, so reaching it means
   * the expedition is longer than one, which is itself worth reporting.
   */
  readonly maxSeconds: Seconds;
  /** The most teams a run will play, however many were asked for. */
  readonly maxTeams: number;
}

/** What a run gives up at when nobody says otherwise. */
export const DEFAULT_SIMULATION_LIMITS: SimulationLimits = {
  maxStepsPerTeam: 2000,
  maxSeconds: 8 * 60 * 60,
  maxTeams: 64,
};

/** What a caller asks the harness for. */
export interface SimulationRequest {
  /** The expedition to play. */
  readonly definition: ExpeditionDefinition;
  /**
   * The mission types to play it with.
   *
   * Required for `judging: 'behaviour'`. Ignored under `scripted`, which
   * builds its own stand-ins (`scripted.ts`).
   */
  readonly registry?: MissionTypeRegistry;
  /** How work handed in is judged. `scripted` unless said otherwise. */
  readonly judging?: SimulationJudging;
  /** The teams to play with. A class is built when this is left out. */
  readonly teams?: readonly SimulatedTeam[];
  /** How many teams to build when none were given. Three by default. */
  readonly teamCount?: number;
  /** What to seed the run's generator with. The same seed replays the run. */
  readonly seed?: string;
  /** When the run begins. Every timestamp in it is measured from here. */
  readonly startedAt?: IsoTimestamp;
  /**
   * A player per mission type key (`players.ts`).
   *
   * Only read under `judging: 'behaviour'`. A key with no player falls back
   * to the sampling player, and the report says which ones did.
   */
  readonly players?: Readonly<Record<string, SimulatedPlayer>>;
  /**
   * How long a teacher takes to look at a submission, in seconds.
   *
   * Five minutes by default. It is the one number in a run that is not about
   * a team, and leaving it out of a timed expedition's estimate would make
   * every review-heavy expedition look quicker than it is.
   */
  readonly reviewSeconds?: Seconds;
  /** Where the run gives up. Each limit falls back to its own default. */
  readonly limits?: Partial<SimulationLimits>;
}

/** One mission, with everything the run reads about it already read. */
export interface PlannedMission {
  readonly mission: MissionInstance;
  /** The stop it sits on, when the graph holds one. */
  readonly nodeId?: NodeId;
  readonly statePolicy: MissionStatePolicy;
  readonly completionPolicy: MissionCompletionPolicy;
  readonly scoringPolicy: MissionScoringPolicy;
  /** `key@version`, for the report and for looking the type up. */
  readonly ref: string;
  /** Whatever the mission type's `prepare` made of its settings (EXPD-009). */
  readonly prepared: unknown;
  /** Who hands work in for it. */
  readonly player: SimulatedPlayer;
  /** Whether that player is the sampling one, which the report has to say. */
  readonly sampled: boolean;
}

/** Everything one run needs, read once. */
export interface SimulationPlan {
  readonly definition: ExpeditionDefinition;
  readonly registry: MissionTypeRegistry;
  readonly judging: SimulationJudging;
  readonly seed: string;
  readonly startedAt: IsoTimestamp;
  readonly teams: readonly SimulatedTeam[];
  readonly limits: SimulationLimits;
  readonly reviewSeconds: Seconds;
  readonly progression: ProgressionPolicy;
  readonly scoring: ExpeditionScoringPolicy;
  /** Every mission in document order, which is the order a team meets them. */
  readonly missions: readonly PlannedMission[];
  readonly missionsById: ReadonlyMap<MissionInstanceId, PlannedMission>;
  /** Whether the expedition hands out hints at all (EXPD-046). */
  readonly hintsEnabled: boolean;
  /** How long the whole expedition may run, when the rules set a limit. */
  readonly totalTimeLimitSeconds: Seconds | null;
  /** Whether late work is scored with a penalty rather than simply accepted. */
  readonly penaliseLateWork: boolean;
  /** The `key@version` refs the document names that no registry could hold. */
  readonly unusableTypeRefs: readonly string[];
}

/** How many teams a run plays when nobody says. */
export const DEFAULT_TEAM_COUNT = 3;

/** How long a teacher takes over one review when nobody says. */
export const DEFAULT_REVIEW_SECONDS: Seconds = 300;

/** The routes the document declares, for dealing out to teams. */
function routeIdsOf(definition: ExpeditionDefinition): readonly RouteId[] {
  return (definition.rules?.routes ?? []).map((route) => route.id);
}

/** Which stop each mission sits on, so a report can name it. */
function nodesByMission(
  definition: ExpeditionDefinition,
): ReadonlyMap<MissionInstanceId, NodeId> {
  const byMission = new Map<MissionInstanceId, NodeId>();
  for (const node of definition.graph?.nodes ?? []) {
    if (node.kind === 'mission' && !byMission.has(node.missionInstanceId)) {
      byMission.set(node.missionInstanceId, node.id);
    }
  }
  return byMission;
}

/**
 * Reads a request into everything a run needs.
 *
 * @throws Error when `judging: 'behaviour'` is asked for with no registry.
 * That is the one mistake the harness cannot work around — there would be
 * nothing to judge with — and it is a caller's mistake rather than a document
 * problem, so it is thrown rather than reported as a finding.
 */
export function planSimulation(request: SimulationRequest): SimulationPlan {
  const definition = request.definition;
  const judging: SimulationJudging = request.judging ?? 'scripted';

  if (judging === 'behaviour' && request.registry === undefined) {
    throw new Error(
      'A simulation that judges with real behaviours needs a mission type ' +
        'registry. Pass one, or use judging: "scripted".',
    );
  }

  const scripted = judging === 'scripted' ? scriptedRegistryFor(definition) : undefined;
  const registry = scripted?.registry ?? (request.registry as MissionTypeRegistry);

  const limits: SimulationLimits = {
    maxStepsPerTeam:
      request.limits?.maxStepsPerTeam ?? DEFAULT_SIMULATION_LIMITS.maxStepsPerTeam,
    maxSeconds: request.limits?.maxSeconds ?? DEFAULT_SIMULATION_LIMITS.maxSeconds,
    maxTeams: request.limits?.maxTeams ?? DEFAULT_SIMULATION_LIMITS.maxTeams,
  };

  const asked =
    request.teams ??
    simulatedTeams(request.teamCount ?? DEFAULT_TEAM_COUNT, {
      routeIds: routeIdsOf(definition),
    });

  const nodeOf = nodesByMission(definition);
  const missions: PlannedMission[] = [];
  const missionsById = new Map<MissionInstanceId, PlannedMission>();
  const rules = definition.rules ?? ({} as ExpeditionDefinition['rules']);

  for (const mission of definition.missions ?? []) {
    if (typeof mission !== 'object' || mission === null) {
      continue;
    }
    const ref = missionTypeRef(mission.missionTypeId, mission.missionTypeVersion);
    const registered = registry.get(mission.missionTypeId, mission.missionTypeVersion);
    const given = request.players?.[mission.missionTypeId];
    const player =
      judging === 'scripted' ? scriptedPlayer : (given ?? samplingPlayer);

    const nodeId = nodeOf.get(mission.id);

    const planned: PlannedMission = {
      mission,
      ...(nodeId === undefined ? {} : { nodeId }),
      statePolicy: missionStatePolicyFor(mission, rules),
      completionPolicy: missionCompletionPolicyFor(mission, rules),
      scoringPolicy: missionScoringPolicyFor(mission),
      ref,
      // Prepared once per mission, exactly as the engine intends. A type that
      // throws on its own config is a type the completion interface will send
      // to review, so nothing is thrown from here either.
      prepared: prepareQuietly(registry, mission),
      player,
      sampled: judging === 'behaviour' && given === undefined && registered?.behaviour !== undefined,
    };
    missions.push(planned);
    missionsById.set(mission.id, planned);
  }

  return {
    definition,
    registry,
    judging,
    seed: request.seed ?? 'expedition',
    startedAt: request.startedAt ?? DEFAULT_SIMULATION_START,
    teams: asked.slice(0, limits.maxTeams),
    limits,
    reviewSeconds: request.reviewSeconds ?? DEFAULT_REVIEW_SECONDS,
    progression: progressionPolicyFor(definition),
    scoring: expeditionScoringPolicyFor(definition),
    missions,
    missionsById,
    hintsEnabled: rules.hints?.enabled === true,
    totalTimeLimitSeconds: rules.timing?.totalTimeLimitSeconds ?? null,
    penaliseLateWork: rules.submissions?.latePolicy === 'accept-with-penalty',
    unusableTypeRefs: scripted?.unusable ?? [],
  };
}

/** Runs a type's `prepare`, and says `undefined` rather than throwing. */
function prepareQuietly(
  registry: MissionTypeRegistry,
  mission: MissionInstance,
): unknown {
  try {
    return registry.prepareConfig(
      mission.missionTypeId,
      mission.missionTypeVersion,
      mission.config,
    );
  } catch {
    return undefined;
  }
}

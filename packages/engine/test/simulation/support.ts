/**
 * What the simulation tests are played against.
 *
 * The harness is the one part of the engine that reads a whole Expedition
 * Definition, so unlike every other test folder here these build real
 * documents: a start, some mission stops, a finish, and the four rule blocks
 * a run reads. What they leave bare is everything no run touches — the cover
 * image, the age range, who wrote it — because a document with every field
 * filled in would hide which ones the harness actually reads.
 */

import type {
  ExpeditionDefinition,
  ExpeditionEdge,
  ExpeditionNode,
  ExpeditionRules,
  HintDefinition,
  JsonObject,
  MissionInstance,
  MissionInstanceId,
  NodeId,
  RouteId,
  ScoringConfig,
  ScoringRule,
  UnlockCondition,
  VerificationMode,
} from '@explorer/shared-types';

/** A mission id, tagged. */
export function missionId(name: string): MissionInstanceId {
  return name as MissionInstanceId;
}

/** A node id, tagged. */
export function nodeId(name: string): NodeId {
  return name as NodeId;
}

/** A route id, tagged. */
export function routeId(name: string): RouteId {
  return name as RouteId;
}

/** How one mission in a test expedition differs from the plainest one. */
export interface MissionOptions {
  readonly basePoints?: number;
  readonly maxAttempts?: number | null;
  readonly timeLimitSeconds?: number;
  readonly verification?: VerificationMode;
  readonly hints?: HintDefinition[];
  readonly missionTypeId?: string;
  readonly missionTypeVersion?: string;
  readonly config?: JsonObject;
  readonly allowPartialCredit?: boolean;
}

/** One mission, worth ten points and judged by its type unless said otherwise. */
export function missionOf(name: string, options: MissionOptions = {}): MissionInstance {
  return {
    id: missionId(name),
    missionTypeId: options.missionTypeId ?? 'code-match',
    missionTypeVersion: options.missionTypeVersion ?? '1.0.0',
    title: name,
    brief: `Do ${name}.`,
    config: options.config ?? {},
    scoring: {
      basePoints: options.basePoints ?? 10,
      allowPartialCredit: options.allowPartialCredit ?? false,
    },
    attempts: { maxAttempts: options.maxAttempts === undefined ? null : options.maxAttempts },
    ...(options.timeLimitSeconds === undefined
      ? {}
      : { timeLimitSeconds: options.timeLimitSeconds }),
    verification: options.verification ?? 'automatic',
    hints: options.hints ?? [],
    media: [],
  };
}

/** Where every team begins. */
export function start(name = 'start'): ExpeditionNode {
  return { id: nodeId(name), title: 'Start', kind: 'start' };
}

/** The stop one mission sits on, named after it. */
export function missionNode(
  name: string,
  options: { optional?: boolean; secret?: boolean } = {},
): ExpeditionNode {
  return {
    id: nodeId(`node-${name}`),
    title: name,
    kind: 'mission',
    missionInstanceId: missionId(name),
    ...(options.optional === undefined ? {} : { optional: options.optional }),
    ...(options.secret === undefined ? {} : { secret: options.secret }),
  };
}

/** A stop that holds nothing. */
export function checkpoint(name: string): ExpeditionNode {
  return { id: nodeId(name), title: name, kind: 'checkpoint' };
}

/** Where the expedition ends. */
export function finish(name = 'finish'): ExpeditionNode {
  return { id: nodeId(name), title: 'Finish', kind: 'finish' };
}

/** A one-way link, id'd after the two stops it joins. */
export function edge(
  from: string,
  to: string,
  options: { condition?: UnlockCondition; routes?: string[] } = {},
): ExpeditionEdge {
  return {
    id: `${from}->${to}` as ExpeditionEdge['id'],
    from: nodeId(from),
    to: nodeId(to),
    ...(options.condition === undefined ? {} : { condition: options.condition }),
    ...(options.routes === undefined
      ? {}
      : { audience: { kind: 'routes', routeIds: options.routes.map(routeId) } }),
  };
}

/** How a test expedition's rules differ from the plainest ones. */
export interface RuleOptions {
  readonly progression?: ExpeditionRules['progression'];
  readonly allowSkip?: boolean;
  readonly routes?: string[];
  readonly hints?: boolean;
  readonly requireReviewForAll?: boolean;
  readonly latePolicy?: ExpeditionRules['submissions']['latePolicy'];
  readonly totalTimeLimitSeconds?: number;
}

/** The four rule blocks a run reads, and the two it does not. */
export function rulesOf(options: RuleOptions = {}): ExpeditionRules {
  return {
    progression: options.progression ?? 'open',
    ...(options.routes === undefined
      ? {}
      : {
          routes: options.routes.map((name) => ({ id: routeId(name), name })),
        }),
    allowSkip: options.allowSkip ?? false,
    teams: { size: { min: 2, max: 5 }, maxTeams: null, roles: [], requireFullTeamToStart: false },
    timing: {
      startMode: 'synchronised',
      endMode: 'first-finish-node',
      ...(options.totalTimeLimitSeconds === undefined
        ? {}
        : { totalTimeLimitSeconds: options.totalTimeLimitSeconds }),
    },
    hints: { enabled: options.hints ?? false, tokensPerTeam: 3 },
    submissions: {
      requireReviewForAll: options.requireReviewForAll ?? false,
      latePolicy: options.latePolicy ?? 'accept',
      allowOfflineQueue: false,
    },
  };
}

/** The scoring half, with whatever rules a test wants and nothing else. */
export function scoringOf(rules: ScoringRule[] = []): ScoringConfig {
  return {
    rules,
    minimumTotal: 0,
    leaderboard: { visibility: 'live', tieBreaks: [] } as ScoringConfig['leaderboard'],
  };
}

/** A whole expedition, assembled from the parts a test names. */
export function expeditionOf(options: {
  missions: MissionInstance[];
  nodes: ExpeditionNode[];
  edges: ExpeditionEdge[];
  rules?: ExpeditionRules;
  scoring?: ScoringConfig;
}): ExpeditionDefinition {
  return {
    schemaVersion: '1.1.0',
    id: 'expedition-under-test' as ExpeditionDefinition['id'],
    definitionVersion: 1,
    status: 'published',
    metadata: {
      title: 'The expedition under test',
      summary: 'Played by nobody real.',
      locale: 'en-GB',
      ageRange: { min: 9, max: 11 },
      expectedDurationMinutes: { min: 45, max: 90 },
      subjects: [],
      tags: [],
      setting: 'outdoor',
      authoring: {
        organisationId: 'org',
        createdBy: 'nobody',
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedBy: 'nobody',
        updatedAt: '2026-05-01T00:00:00.000Z',
        source: 'studio',
      },
    },
    missions: options.missions,
    graph: { nodes: options.nodes, edges: options.edges },
    rules: options.rules ?? rulesOf(),
    scoring: options.scoring ?? scoringOf(),
  };
}

/**
 * start → alpha → bravo → charlie → finish, with nothing in the way.
 *
 * The expedition most of these tests are played on: three missions in a line,
 * every one of them judged by its type, unlimited tries, ten points each.
 */
export function straightLine(
  options: { rules?: ExpeditionRules; scoring?: ScoringConfig; missions?: MissionOptions } = {},
): ExpeditionDefinition {
  const names = ['alpha', 'bravo', 'charlie'];
  return expeditionOf({
    missions: names.map((name) => missionOf(name, options.missions ?? {})),
    nodes: [start(), ...names.map((name) => missionNode(name)), finish()],
    edges: [
      edge('start', 'node-alpha'),
      edge('node-alpha', 'node-bravo'),
      edge('node-bravo', 'node-charlie'),
      edge('node-charlie', 'finish'),
    ],
    ...(options.rules === undefined ? {} : { rules: options.rules }),
    ...(options.scoring === undefined ? {} : { scoring: options.scoring }),
  });
}

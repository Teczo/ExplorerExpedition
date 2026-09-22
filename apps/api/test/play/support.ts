/**
 * Standing the mission play endpoints up, for EXPD-020's tests.
 *
 * Real requests with real tokens, for the reason EXPD-017 to EXPD-019 give: a
 * good deal of what this ticket promises is about the stack in front of the
 * handler. A teacher cannot play for a team, a phone cannot mark its own work
 * complete, another school's run is not found, and a phone plays for the team
 * its student is on and no other.
 *
 * Everything this ticket plays against is seeded, because making it belongs
 * to the tickets before this one: the expedition and its flat copy
 * (EXPD-017), the students and the teams (EXPD-018), and a run that is
 * already under way (EXPD-019).
 *
 * The expedition is small and says what it is for:
 *
 *     start ──▶ gate ──▶ tower ──▶ finish
 *       │                            ▲
 *       └────▶ photo ────────────────┘
 *
 *   - `gate` is a `code-match` mission, a type that comes as code and judges
 *     for itself. Two tries, two hints, and a thirty-second cooldown.
 *   - `photo` is a `photo-evidence` mission, a type that is a row and
 *     nothing else, so the engine sends its work to a teacher.
 *   - `tower` is behind `gate`, and locked until `gate` is cleared.
 *   - `ghost` is a mission of a type nobody has registered at all.
 */

import type { Express } from 'express';
import { defineMissionType, type MissionTypeEntry } from '@explorer/engine';
import type { JsonObject, OrganisationId } from '@explorer/shared-types';

import { createApp } from '../../src/app.ts';
import { signAccessToken, signingKey } from '../../src/auth/tokens.ts';
import { DEFAULT_LIFETIMES, type AuthConfig } from '../../src/config/auth-config.ts';
import { FakeDatabase, type FakeRow } from '../support/fake-database.ts';
import { ORG_A, ORG_B } from '../support/organisations.ts';
import { listen, send, type Answer, type RunningApp } from '../http/support.ts';

export { ORG_A, ORG_B };

/** The settings the tests sign their own tokens with. */
export const CONFIG: AuthConfig = {
  signingKey: signingKey('f'.repeat(32)),
  lifetimes: DEFAULT_LIFETIMES,
};

export const TEACHER = '66666666-6666-4666-8666-666666666666';
export const EXPEDITION_A = 'a0000000-0000-4000-8000-0000000000e1';
export const VERSION_A = 'a0000000-0000-4000-8000-000000000091';
export const RUN_A = 'a0000000-0000-4000-8000-00000000aaaa';
/** A second run in the same school, for a phone that belongs to the first. */
export const RUN_A2 = 'a0000000-0000-4000-8000-00000000aaa2';
/** Riverbank Academy's run. A test must never reach it. */
export const RUN_B = 'b0000000-0000-4000-8000-00000000bbbb';

export const TEAM_RED = 'a0000000-0000-4000-8000-0000000000d1';
export const TEAM_BLUE = 'a0000000-0000-4000-8000-0000000000d2';
export const TEAM_B = 'b0000000-0000-4000-8000-0000000000d3';

/** Asha and Ben play for Red; Cal for Blue. */
export const ASHA = 'a0000000-0000-4000-8000-0000000000f1';
export const BEN = 'a0000000-0000-4000-8000-0000000000f2';
export const CAL = 'a0000000-0000-4000-8000-0000000000f3';
/** In the run and on no team yet. */
export const DEV = 'a0000000-0000-4000-8000-0000000000f4';
/** Taken out of the run by a teacher. */
export const EVE = 'a0000000-0000-4000-8000-0000000000f5';
/** Riverbank's student. */
export const RIA = 'b0000000-0000-4000-8000-0000000000f6';

export const MISSING_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** The `mission_instance` row ids, one per mission in the document. */
export const MISSION_ROWS: Readonly<Record<string, string>> = {
  gate: 'a0000000-0000-4000-8000-000000000c01',
  photo: 'a0000000-0000-4000-8000-000000000c02',
  tower: 'a0000000-0000-4000-8000-000000000c03',
  ghost: 'a0000000-0000-4000-8000-000000000c04',
};

/** A type that comes as code: right when the code typed is the configured one. */
export const codeMatch: MissionTypeEntry = defineMissionType({
  definition: {
    key: 'code-match',
    version: '1.0.0',
    name: 'Code match',
    description: 'Teams type a code they found.',
    status: 'published',
    capabilities: [],
    configSchema: {
      type: 'object',
      properties: { code: { type: 'string', minLength: 1 } },
      required: ['code'],
    },
    submissionSchema: {
      type: 'object',
      properties: { code: { type: 'string' } },
      required: ['code'],
    },
    defaultConfig: { code: 'change-me' },
  },
  behaviour: {
    evaluate({ config, submission }) {
      return {
        outcome: submission['code'] === config['code'] ? 'correct' : 'incorrect',
        feedback: submission['code'] === config['code'] ? 'That is the code.' : 'Not that one.',
      };
    },
  },
});

/** What the fixture's expedition may be changed by, test by test. */
export interface FixtureOptions {
  readonly progression?: 'strict' | 'open' | 'free-roam';
  readonly hints?: boolean;
  readonly totalTimeLimitSeconds?: number;
  readonly latePolicy?: 'reject' | 'accept' | 'accept-with-penalty';
  readonly cooldownSeconds?: number;
  readonly gateMaxAttempts?: number | null;
  readonly runStatus?: string;
  /** How long ago the run started. Ten minutes unless said. */
  readonly startedSecondsAgo?: number;
}

function missionOf(
  id: string,
  type: string,
  options: {
    readonly basePoints: number;
    readonly maxAttempts?: number | null;
    readonly cooldownSeconds?: number;
    readonly config?: JsonObject;
    readonly hints?: JsonObject[];
  },
): JsonObject {
  return {
    id,
    missionTypeId: type,
    missionTypeVersion: '1.0.0',
    title: id,
    brief: `Do ${id}.`,
    config: options.config ?? {},
    scoring: { basePoints: options.basePoints, allowPartialCredit: false },
    attempts: {
      maxAttempts: options.maxAttempts === undefined ? null : options.maxAttempts,
      ...(options.cooldownSeconds === undefined ? {} : { cooldownSeconds: options.cooldownSeconds }),
    },
    verification: 'automatic',
    hints: options.hints ?? [],
    media: [],
  };
}

/** The expedition document every run here is pinned to. */
export function definitionOf(options: FixtureOptions = {}): JsonObject {
  return {
    schemaVersion: '1.1.0',
    id: EXPEDITION_A,
    definitionVersion: 1,
    status: 'published',
    metadata: { title: 'The River Trail' },
    missions: [
      missionOf('gate', 'code-match', {
        basePoints: 10,
        maxAttempts: options.gateMaxAttempts === undefined ? 2 : options.gateMaxAttempts,
        ...(options.cooldownSeconds === undefined ? {} : { cooldownSeconds: options.cooldownSeconds }),
        config: { code: 'OTTER' },
        hints: [
          { id: 'gate-hint-2', text: 'It swims.', order: 2, tokenCost: 1 },
          { id: 'gate-hint-1', text: 'Look on the gatepost.', order: 1, tokenCost: 1 },
        ],
      }),
      missionOf('photo', 'photo-evidence', { basePoints: 20 }),
      missionOf('tower', 'code-match', { basePoints: 30, config: { code: 'HERON' } }),
      missionOf('ghost', 'nobody-registered-this', { basePoints: 5 }),
    ],
    graph: {
      nodes: [
        { id: 'start', title: 'Start', kind: 'start' },
        { id: 'node-gate', title: 'Gate', kind: 'mission', missionInstanceId: 'gate' },
        { id: 'node-photo', title: 'Photo', kind: 'mission', missionInstanceId: 'photo' },
        { id: 'node-tower', title: 'Tower', kind: 'mission', missionInstanceId: 'tower' },
        { id: 'node-ghost', title: 'Ghost', kind: 'mission', missionInstanceId: 'ghost' },
        { id: 'finish', title: 'Finish', kind: 'finish' },
      ],
      edges: [
        { id: 'start->node-gate', from: 'start', to: 'node-gate' },
        { id: 'start->node-photo', from: 'start', to: 'node-photo' },
        { id: 'start->node-ghost', from: 'start', to: 'node-ghost' },
        { id: 'node-gate->node-tower', from: 'node-gate', to: 'node-tower' },
        { id: 'node-tower->finish', from: 'node-tower', to: 'finish' },
        { id: 'node-photo->finish', from: 'node-photo', to: 'finish' },
      ],
    },
    rules: {
      progression: options.progression ?? 'open',
      allowSkip: false,
      teams: { size: { min: 1, max: 5 }, maxTeams: null, roles: [], requireFullTeamToStart: false },
      timing: {
        startMode: 'synchronised',
        endMode: 'teacher-ends',
        ...(options.totalTimeLimitSeconds === undefined
          ? {}
          : { totalTimeLimitSeconds: options.totalTimeLimitSeconds }),
      },
      hints: { enabled: options.hints ?? true, tokensPerTeam: 3 },
      submissions: {
        requireReviewForAll: false,
        latePolicy: options.latePolicy ?? 'accept',
        allowOfflineQueue: false,
      },
    },
    scoring: {
      rules: [
        { id: 'hint-cost', type: 'hint-penalty', target: { kind: 'all' }, pointsPerHint: 3 },
        {
          id: 'wrong-answer',
          type: 'attempt-penalty',
          target: { kind: 'all' },
          pointsPerFailedAttempt: 2,
        },
        {
          id: 'first-there',
          type: 'first-to-complete-bonus',
          target: { kind: 'all' },
          points: 5,
        },
        {
          id: 'late',
          type: 'late-penalty',
          graceSeconds: 0,
          pointsPerMinute: 1,
        },
      ],
      minimumTotal: -1000,
      leaderboard: { visibility: 'live', tieBreaks: [] },
    },
  };
}

function participant(id: string, sessionId: string, organisationId: string, status = 'joined'): FakeRow {
  return {
    id,
    organisation_id: organisationId,
    expedition_session_id: sessionId,
    display_name: id.slice(-2),
    status,
    device_id: null,
    joined_at: new Date(),
    left_at: null,
  };
}

function team(id: string, sessionId: string, organisationId: string, name: string): FakeRow {
  return {
    id,
    organisation_id: organisationId,
    expedition_session_id: sessionId,
    name,
    status: 'playing',
    total_score: 0,
    hint_tokens_remaining: 0,
    stream_length: '0',
    stream_head_hash: null,
    streak: 0,
    longest_streak: 0,
    failed_attempts: 0,
  };
}

function member(teamId: string, participantId: string, organisationId: string): FakeRow {
  return {
    id: `member-${participantId}`,
    organisation_id: organisationId,
    team_id: teamId,
    participant_id: participantId,
    role: null,
    is_leader: false,
    joined_at: new Date(),
    left_at: null,
  };
}

/** Writes everything a run under way is made of. */
export function seed(db: FakeDatabase, options: FixtureOptions = {}): void {
  const startedAt = new Date(Date.now() - (options.startedSecondsAgo ?? 600) * 1000);
  const status = options.runStatus ?? 'running';

  db.seed('expedition_version', {
    id: VERSION_A,
    organisation_id: ORG_A,
    expedition_id: EXPEDITION_A,
    definition_version: 1,
    status: 'published',
    definition: definitionOf(options),
  });

  for (const [key, id] of Object.entries(MISSION_ROWS)) {
    db.seed('mission_instance', {
      id,
      organisation_id: ORG_A,
      expedition_version_id: VERSION_A,
      instance_key: key,
    });
  }
  db.seed(
    'hint',
    {
      id: 'a0000000-0000-4000-8000-000000000b01',
      organisation_id: ORG_A,
      mission_instance_id: MISSION_ROWS['gate'],
      hint_key: 'gate-hint-1',
    },
    {
      id: 'a0000000-0000-4000-8000-000000000b02',
      organisation_id: ORG_A,
      mission_instance_id: MISSION_ROWS['gate'],
      hint_key: 'gate-hint-2',
    },
  );

  // A platform-wide type: a row, and nothing to judge with.
  db.seed('mission_type', {
    id: 'a0000000-0000-4000-8000-0000000007e1',
    organisation_id: null,
    type_key: 'photo-evidence',
    version: '1.0.0',
    name: 'Photo evidence',
    description: 'Teams take a photo, and a person decides.',
    status: 'published',
    capabilities: ['camera'],
    config_schema: {},
    submission_schema: {
      type: 'object',
      properties: { mediaId: { type: 'string' } },
      required: ['mediaId'],
    },
    default_config: {},
  });

  const run = (id: string, organisationId: string): FakeRow => ({
    id,
    organisation_id: organisationId,
    expedition_id: EXPEDITION_A,
    expedition_version_id: VERSION_A,
    name: 'Year 6 — Tuesday',
    join_code: id === RUN_A ? 'HJ4KMN' : 'HJ4KMP',
    status,
    host_user_id: TEACHER,
    scheduled_start_at: null,
    started_at: status === 'lobby' || status === 'scheduled' ? null : startedAt,
    paused_at: status === 'paused' ? new Date() : null,
    paused_seconds_total: 0,
    extended_seconds_total: 0,
    ended_at: status === 'ended' ? new Date() : null,
    created_by: TEACHER,
  });
  db.seed('expedition_session', run(RUN_A, ORG_A), run(RUN_A2, ORG_A), run(RUN_B, ORG_B));

  db.seed(
    'participant',
    participant(ASHA, RUN_A, ORG_A),
    participant(BEN, RUN_A, ORG_A),
    participant(CAL, RUN_A, ORG_A),
    participant(DEV, RUN_A, ORG_A),
    participant(EVE, RUN_A, ORG_A, 'removed'),
    participant(RIA, RUN_B, ORG_B),
  );
  db.seed(
    'team',
    team(TEAM_RED, RUN_A, ORG_A, 'Red'),
    team(TEAM_BLUE, RUN_A, ORG_A, 'Blue'),
    team(TEAM_B, RUN_B, ORG_B, 'Kingfishers'),
  );
  db.seed(
    'team_member',
    member(TEAM_RED, ASHA, ORG_A),
    member(TEAM_RED, BEN, ORG_A),
    member(TEAM_BLUE, CAL, ORG_A),
    member(TEAM_B, RIA, ORG_B),
  );
}

/** A token for a student's phone. */
export function phone(
  participantId: string,
  options: { readonly sessionId?: string; readonly organisationId?: OrganisationId | string } = {},
): string {
  return signAccessToken(
    CONFIG.signingKey,
    {
      sub: participantId,
      aud: 'device',
      org: options.organisationId ?? ORG_A,
      ses: options.sessionId ?? RUN_A,
      dev: '88888888-8888-4888-8888-888888888888',
    },
    DEFAULT_LIFETIMES.accessSeconds,
  );
}

/** A token for a staff account. */
export function staff(
  options: { readonly role?: string; readonly organisationId?: OrganisationId | string } = {},
): string {
  return signAccessToken(
    CONFIG.signingKey,
    {
      sub: TEACHER,
      aud: 'user',
      org: options.organisationId ?? ORG_A,
      role: options.role ?? 'facilitator',
      sid: 'membership-1',
    },
    DEFAULT_LIFETIMES.accessSeconds,
  );
}

/** A running API, and the calls a test makes against it. */
export interface Harness {
  readonly db: FakeDatabase;
  readonly app: RunningApp;
  start(bearer: string, mission: string, sessionId?: string): Promise<Answer>;
  submit(bearer: string, mission: string, body: unknown, sessionId?: string): Promise<Answer>;
  hint(bearer: string, mission: string, body?: unknown): Promise<Answer>;
  decide(bearer: string, teamId: string, mission: string, body: unknown, sessionId?: string): Promise<Answer>;
  rows(table: string): readonly FakeRow[];
  close(): Promise<void>;
}

/** The whole API, with the fixture seeded and `code-match` given as code. */
export function playApp(db: FakeDatabase): Express {
  return createApp({ db, authConfig: CONFIG, missionTypes: [codeMatch] });
}

export async function harness(options: FixtureOptions = {}): Promise<Harness> {
  const db = new FakeDatabase();
  seed(db, options);
  const app = await listen(playApp(db));

  const post = (path: string, bearer: string, body?: unknown): Promise<Answer> =>
    send(app, path, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  return {
    db,
    app,
    start: (bearer, mission, sessionId = RUN_A) =>
      post(`/sessions/${sessionId}/missions/${mission}/attempts`, bearer),
    submit: (bearer, mission, body, sessionId = RUN_A) =>
      post(`/sessions/${sessionId}/missions/${mission}/submissions`, bearer, body),
    hint: (bearer, mission, body) =>
      post(`/sessions/${RUN_A}/missions/${mission}/hints`, bearer, body),
    decide: (bearer, teamId, mission, body, sessionId = RUN_A) =>
      post(`/sessions/${sessionId}/teams/${teamId}/missions/${mission}/complete`, bearer, body),
    rows: (table) => db.rowsIn(table),
    close: () => app.close(),
  };
}

/** The refusal code out of an error answer. */
export function refusalOf(answer: Answer): string | undefined {
  const refusal = answer.body['refusal'] as Record<string, unknown> | undefined;
  return refusal === undefined ? undefined : String(refusal['code']);
}

/** The mission out of a play answer. */
export function missionIn(answer: Answer): Record<string, unknown> {
  return answer.body['mission'] as Record<string, unknown>;
}

/** The score out of a play answer. */
export function scoreOf(answer: Answer): { total: number; events: Record<string, unknown>[] } {
  return answer.body['score'] as { total: number; events: Record<string, unknown>[] };
}

/** One team's rows in a table. */
export function teamRows(h: Harness, table: string, teamId: string): readonly FakeRow[] {
  return h.rows(table).filter((row) => row['team_id'] === teamId);
}

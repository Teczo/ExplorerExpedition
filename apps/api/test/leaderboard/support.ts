/**
 * Standing the leaderboard endpoints up, for EXPD-022's tests.
 *
 * Real requests with real tokens, for the reason EXPD-017 to EXPD-020 give:
 * much of what this ticket promises is about who may read what, and that is
 * decided by the stack in front of the handler as much as by the handler.
 *
 * Everything the boards are drawn from is seeded, because writing it belongs
 * to the tickets before this one: the runs (EXPD-019), the teams and students
 * (EXPD-018), and the figures (EXPD-014, EXPD-020).
 *
 * Portside School has one expedition, the River Trail, played three times:
 *
 *   - `RUN_LIVE`, under way, with Otters (Asha, Ben), Herons (Cal) and a
 *     withdrawn team, Voles.
 *   - `RUN_DONE`, over, with Kingfishers (Dee).
 *   - `RUN_OLD`, over, pinned to an older revision, with Newts (Eli).
 *
 * Riverbank Academy has a run of its own, with Pike, that no test may reach.
 */

import type { LeaderboardTieBreak, LeaderboardVisibility, OrganisationId } from '@explorer/shared-types';

import { createApp } from '../../src/app.ts';
import { signAccessToken, signingKey } from '../../src/auth/tokens.ts';
import { DEFAULT_LIFETIMES, type AuthConfig } from '../../src/config/auth-config.ts';
import { FakeDatabase, type FakeRow } from '../support/fake-database.ts';
import { ORG_A, ORG_B } from '../support/organisations.ts';
import { listen, send, type Answer, type RunningApp } from '../http/support.ts';

export { ORG_A, ORG_B };

export const CONFIG: AuthConfig = {
  signingKey: signingKey('e'.repeat(32)),
  lifetimes: DEFAULT_LIFETIMES,
};

export const TEACHER = '66666666-6666-4666-8666-666666666666';
export const EXPEDITION_A = 'a0000000-0000-4000-8000-0000000000e1';
export const EXPEDITION_B = 'b0000000-0000-4000-8000-0000000000e2';
export const VERSION_1 = 'a0000000-0000-4000-8000-000000000091';
export const VERSION_2 = 'a0000000-0000-4000-8000-000000000092';
export const VERSION_B = 'b0000000-0000-4000-8000-000000000093';

export const RUN_LIVE = 'a0000000-0000-4000-8000-00000000aaa1';
export const RUN_DONE = 'a0000000-0000-4000-8000-00000000aaa2';
export const RUN_OLD = 'a0000000-0000-4000-8000-00000000aaa3';
export const RUN_B = 'b0000000-0000-4000-8000-00000000bbbb';

export const OTTERS = 'a0000000-0000-4000-8000-0000000000d1';
export const HERONS = 'a0000000-0000-4000-8000-0000000000d2';
export const VOLES = 'a0000000-0000-4000-8000-0000000000d3';
export const KINGFISHERS = 'a0000000-0000-4000-8000-0000000000d4';
export const NEWTS = 'a0000000-0000-4000-8000-0000000000d5';
export const PIKE = 'b0000000-0000-4000-8000-0000000000d6';

export const ASHA = 'a0000000-0000-4000-8000-0000000000f1';
export const BEN = 'a0000000-0000-4000-8000-0000000000f2';
export const CAL = 'a0000000-0000-4000-8000-0000000000f3';
export const DEE = 'a0000000-0000-4000-8000-0000000000f4';
export const ELI = 'a0000000-0000-4000-8000-0000000000f5';
/** On Otters once, and taken out of the run since. */
export const FAY = 'a0000000-0000-4000-8000-0000000000f7';
export const RIA = 'b0000000-0000-4000-8000-0000000000f6';

export const MISSING_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** A device id nobody should ever see on a board. */
export const DEVICE_ID = 'phone-serial-do-not-show';

/** How the fixture's revisions set up their boards. */
export interface BoardOptions {
  readonly visibility?: LeaderboardVisibility;
  readonly tieBreaks?: LeaderboardTieBreak[];
  /** The older revision's settings, which `RUN_OLD` is pinned to. */
  readonly oldVisibility?: LeaderboardVisibility;
  readonly oldTieBreaks?: LeaderboardTieBreak[];
}

const START = new Date('2026-09-01T09:00:00.000Z');
const at = (seconds: number): Date => new Date(START.getTime() + seconds * 1000);

function version(
  id: string,
  organisationId: string,
  expeditionId: string,
  definitionVersion: number,
  visibility: LeaderboardVisibility,
  tieBreaks: LeaderboardTieBreak[],
): FakeRow {
  return {
    id,
    organisation_id: organisationId,
    expedition_id: expeditionId,
    definition_version: definitionVersion,
    status: 'published',
    definition: { scoring: { rules: [], minimumTotal: 0, leaderboard: { visibility, tieBreaks } } },
  };
}

function run(
  id: string,
  organisationId: string,
  expeditionId: string,
  versionId: string,
  name: string,
  status: string,
): FakeRow {
  return {
    id,
    organisation_id: organisationId,
    expedition_id: expeditionId,
    expedition_version_id: versionId,
    name,
    join_code: id.slice(-6).toUpperCase(),
    status,
    host_user_id: TEACHER,
    started_at: START,
    ended_at: status === 'ended' ? at(3600) : null,
    created_at: START,
  };
}

function team(
  id: string,
  organisationId: string,
  sessionId: string,
  name: string,
  figures: { total: number; failed?: number; status?: string },
): FakeRow {
  return {
    id,
    organisation_id: organisationId,
    expedition_session_id: sessionId,
    name,
    status: figures.status ?? 'playing',
    total_score: figures.total,
    failed_attempts: figures.failed ?? 0,
    finished_at: null,
  };
}

function participant(id: string, organisationId: string, sessionId: string, name: string, status = 'active'): FakeRow {
  return {
    id,
    organisation_id: organisationId,
    expedition_session_id: sessionId,
    display_name: name,
    status,
    device_id: DEVICE_ID,
    user_id: null,
  };
}

function member(teamId: string, participantId: string, organisationId: string, joinedSecond: number): FakeRow {
  return {
    id: `member-${participantId}`,
    organisation_id: organisationId,
    team_id: teamId,
    participant_id: participantId,
    role: 'navigator',
    is_leader: true,
    joined_at: at(joinedSecond),
    left_at: null,
  };
}

function completion(organisationId: string, sessionId: string, teamId: string, key: string): FakeRow {
  return {
    organisation_id: organisationId,
    expedition_session_id: sessionId,
    team_id: teamId,
    mission_instance_key: key,
    to_state: 'complete',
  };
}

function finish(organisationId: string, sessionId: string, teamId: string, second: number): FakeRow {
  return {
    organisation_id: organisationId,
    expedition_session_id: sessionId,
    team_id: teamId,
    reason: 'expedition-finished',
    occurred_at: at(second),
  };
}

function hint(organisationId: string, sessionId: string, teamId: string, key: string): FakeRow {
  return {
    organisation_id: organisationId,
    expedition_session_id: sessionId,
    team_id: teamId,
    participant_id: ASHA,
    mission_instance_key: 'gate',
    hint_key: key,
  };
}

/**
 * Writes the fixture.
 *
 * On `RUN_LIVE`, Otters and Herons are level on 40. Otters finished two
 * missions, opened two hints, had one wrong answer and finished at 20 minutes.
 * Herons finished one, opened none, had three wrong answers and finished at
 * 15 minutes. So each tie break puts a different team first:
 *
 *   earliest-finish           Herons
 *   most-missions-completed   Otters
 *   fewest-hints-used         Herons
 *   fewest-failed-attempts    Otters
 */
export function seed(db: FakeDatabase, options: BoardOptions = {}): void {
  db.seed(
    'expedition',
    { id: EXPEDITION_A, organisation_id: ORG_A, status: 'published' },
    { id: EXPEDITION_B, organisation_id: ORG_B, status: 'published' },
  );
  db.seed(
    'expedition_version',
    version(VERSION_1, ORG_A, EXPEDITION_A, 1, options.oldVisibility ?? 'live', options.oldTieBreaks ?? []),
    version(VERSION_2, ORG_A, EXPEDITION_A, 2, options.visibility ?? 'live', options.tieBreaks ?? []),
    version(VERSION_B, ORG_B, EXPEDITION_B, 1, 'live', []),
  );
  db.seed(
    'expedition_session',
    run(RUN_LIVE, ORG_A, EXPEDITION_A, VERSION_2, 'Year 6 — Tuesday', 'running'),
    run(RUN_DONE, ORG_A, EXPEDITION_A, VERSION_2, 'Year 5 — Monday', 'ended'),
    run(RUN_OLD, ORG_A, EXPEDITION_A, VERSION_1, 'Year 4 — last term', 'ended'),
    run(RUN_B, ORG_B, EXPEDITION_B, VERSION_B, 'Riverbank', 'ended'),
  );
  db.seed(
    'team',
    team(OTTERS, ORG_A, RUN_LIVE, 'Otters', { total: 40, failed: 1 }),
    team(HERONS, ORG_A, RUN_LIVE, 'Herons', { total: 40, failed: 3 }),
    team(VOLES, ORG_A, RUN_LIVE, 'Voles', { total: 999, status: 'withdrawn' }),
    team(KINGFISHERS, ORG_A, RUN_DONE, 'Kingfishers', { total: 55, status: 'finished' }),
    team(NEWTS, ORG_A, RUN_OLD, 'Newts', { total: 10, status: 'finished' }),
    team(PIKE, ORG_B, RUN_B, 'Pike', { total: 500, status: 'finished' }),
  );
  db.seed(
    'participant',
    participant(ASHA, ORG_A, RUN_LIVE, 'Asha'),
    participant(BEN, ORG_A, RUN_LIVE, 'Ben'),
    participant(CAL, ORG_A, RUN_LIVE, 'Cal'),
    participant(FAY, ORG_A, RUN_LIVE, 'Fay', 'removed'),
    participant(DEE, ORG_A, RUN_DONE, 'Dee'),
    participant(ELI, ORG_A, RUN_OLD, 'Eli'),
    participant(RIA, ORG_B, RUN_B, 'Ria'),
  );
  db.seed(
    'team_member',
    member(OTTERS, BEN, ORG_A, 20),
    member(OTTERS, ASHA, ORG_A, 10),
    member(OTTERS, FAY, ORG_A, 30),
    member(HERONS, CAL, ORG_A, 10),
    member(KINGFISHERS, DEE, ORG_A, 10),
    member(NEWTS, ELI, ORG_A, 10),
    member(PIKE, RIA, ORG_B, 10),
  );
  db.seed(
    'mission_transition',
    completion(ORG_A, RUN_LIVE, OTTERS, 'gate'),
    completion(ORG_A, RUN_LIVE, OTTERS, 'tower'),
    // The same mission finished twice over is still one mission.
    completion(ORG_A, RUN_LIVE, OTTERS, 'tower'),
    completion(ORG_A, RUN_LIVE, HERONS, 'photo'),
    completion(ORG_A, RUN_DONE, KINGFISHERS, 'gate'),
    completion(ORG_B, RUN_B, PIKE, 'gate'),
  );
  db.seed(
    'hint_request',
    hint(ORG_A, RUN_LIVE, OTTERS, 'gate-hint-1'),
    hint(ORG_A, RUN_LIVE, OTTERS, 'gate-hint-2'),
  );
  db.seed(
    'progression_event',
    finish(ORG_A, RUN_LIVE, OTTERS, 1200),
    finish(ORG_A, RUN_LIVE, HERONS, 900),
    finish(ORG_A, RUN_DONE, KINGFISHERS, 1800),
  );
}

/** A token for a student's phone. */
export function phone(participantId: string, sessionId: string = RUN_LIVE, organisationId: string = ORG_A): string {
  return signAccessToken(
    CONFIG.signingKey,
    {
      sub: participantId,
      aud: 'device',
      org: organisationId,
      ses: sessionId,
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

/** A running API, and the two reads a test makes against it. */
export interface Harness {
  readonly db: FakeDatabase;
  sessionBoard(bearer: string, sessionId?: string): Promise<Answer>;
  expeditionBoard(bearer: string, expeditionId?: string, query?: string): Promise<Answer>;
  close(): Promise<void>;
}

export async function harness(options: BoardOptions = {}): Promise<Harness> {
  const db = new FakeDatabase();
  seed(db, options);
  const app: RunningApp = await listen(createApp({ db, authConfig: CONFIG }));
  const get = (path: string, bearer: string): Promise<Answer> =>
    send(app, path, { headers: { authorization: `Bearer ${bearer}` } });

  return {
    db,
    sessionBoard: (bearer, sessionId = RUN_LIVE) => get(`/sessions/${sessionId}/leaderboard`, bearer),
    expeditionBoard: (bearer, expeditionId = EXPEDITION_A, query = '') =>
      get(`/expeditions/${expeditionId}/leaderboard${query}`, bearer),
    close: () => app.close(),
  };
}

/** The standings out of a board. */
export function standingsOf(answer: Answer): Record<string, unknown>[] {
  return answer.body['standings'] as Record<string, unknown>[];
}

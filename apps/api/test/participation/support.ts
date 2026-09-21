/**
 * Standing the join, team and participant endpoints up, for EXPD-018's tests.
 *
 * The tests here send real requests with real tokens, for the reason
 * EXPD-017's do: most of what this ticket promises is about the stack in
 * front of the handler rather than the handler itself. Another organisation's
 * run is not found, a student's phone cannot draw a team sheet, and the entry
 * in the audit log names whoever really called. A test that called the
 * service directly would prove none of that.
 *
 * Runs are seeded rather than created through an endpoint, because making a
 * run is EXPD-019 and there is no endpoint for it yet. `seedRun` writes the
 * two rows a run needs — the revision it is pinned to, and the run itself —
 * straight into the in-memory database, which is what a migrated schema would
 * hold after EXPD-019's endpoint had been called.
 */

import type { Express } from 'express';
import type { JsonObject, OrganisationId, TeamRules } from '@explorer/shared-types';

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

/** The staff account most of these tests act as. */
export const TEACHER = '66666666-6666-4666-8666-666666666666';

/** The run Portside School is putting on. */
export const RUN_A = 'a0000000-0000-4000-8000-00000000aaaa';

/** The run Riverbank Academy is putting on. A test must never reach it. */
export const RUN_B = 'b0000000-0000-4000-8000-00000000bbbb';

/** The revision `RUN_A` is pinned to. */
export const VERSION_A = 'a0000000-0000-4000-8000-00000000vvvv'.replace(/v/gu, '9');

/** The revision `RUN_B` is pinned to. */
export const VERSION_B = 'b0000000-0000-4000-8000-00000000vvvv'.replace(/v/gu, '9');

/** The code on Portside School's whiteboard. */
export const CODE_A = 'HJ4KMN';

/** The code on Riverbank Academy's. */
export const CODE_B = 'PRT789';

/** An id no row has. */
export const MISSING_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** The whole API, with a database that keeps its rows in memory. */
export function participationApp(db: FakeDatabase): Express {
  return createApp({ db, authConfig: CONFIG });
}

/** A token for a staff account acting for one organisation. */
export function token(
  organisationId: OrganisationId | string,
  options: { readonly role?: string; readonly userId?: string } = {},
): string {
  return signAccessToken(
    CONFIG.signingKey,
    {
      sub: options.userId ?? TEACHER,
      aud: 'user',
      org: organisationId,
      role: options.role ?? 'org-admin',
      sid: 'membership-1',
    },
    DEFAULT_LIFETIMES.accessSeconds,
  );
}

/** A request with a bearer token and, when there is one, a JSON body. */
export function as(
  bearer: string,
  init: { readonly method?: string; readonly body?: unknown } = {},
): RequestInit {
  const headers: Record<string, string> = { authorization: `Bearer ${bearer}` };
  if (init.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  return {
    method: init.method ?? 'GET',
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  };
}

/** A body with no token, for the one endpoint that needs none. */
export function anonymous(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** The team rules a run plays by when a test does not say otherwise. */
export const DEFAULT_RULES: TeamRules = {
  size: { min: 2, max: 3 },
  maxTeams: null,
  roles: ['navigator', 'scribe'],
  requireFullTeamToStart: false,
};

/**
 * A document with nothing in it but the rules.
 *
 * `teamRulesOf` reads `rules.teams` and nothing else, so a fixture that
 * carried a whole valid expedition would only be saying that this ticket
 * ignores the rest of it at greater length.
 */
export function definitionWith(rules: Partial<TeamRules> = {}): JsonObject {
  const teams = { ...DEFAULT_RULES, ...rules };
  return {
    schemaVersion: '1.1.0',
    rules: {
      teams: {
        size: { min: teams.size.min, max: teams.size.max },
        maxTeams: teams.maxTeams,
        roles: [...teams.roles],
        requireFullTeamToStart: teams.requireFullTeamToStart,
      },
    },
  };
}

/** What one seeded run is made of. */
export interface SeededRun {
  readonly sessionId: string;
  readonly organisationId: string;
  readonly joinCode: string;
}

/** Writes a run and the revision it is pinned to. */
export function seedRun(
  db: FakeDatabase,
  over: {
    readonly sessionId?: string;
    readonly versionId?: string;
    readonly organisationId?: string;
    readonly joinCode?: string;
    readonly status?: string;
    readonly rules?: Partial<TeamRules>;
  } = {},
): SeededRun {
  const sessionId = over.sessionId ?? RUN_A;
  const versionId = over.versionId ?? VERSION_A;
  const organisationId = over.organisationId ?? ORG_A;
  const joinCode = over.joinCode ?? CODE_A;

  db.seed('expedition_version', {
    id: versionId,
    organisation_id: organisationId,
    expedition_id: `${sessionId}-expedition`,
    definition_version: 1,
    status: 'published',
    definition: definitionWith(over.rules ?? {}),
  });

  db.seed('expedition_session', {
    id: sessionId,
    organisation_id: organisationId,
    expedition_id: `${sessionId}-expedition`,
    expedition_version_id: versionId,
    name: 'Year 6 — Tuesday',
    join_code: joinCode,
    status: over.status ?? 'lobby',
    host_user_id: TEACHER,
    created_at: new Date('2026-01-01T09:00:00.000Z'),
    updated_at: new Date('2026-01-01T09:00:00.000Z'),
  });

  return { sessionId, organisationId, joinCode };
}

/** A running API, and the two calls a test makes against it. */
export interface Harness {
  readonly db: FakeDatabase;
  readonly app: RunningApp;
  request(path: string, init?: RequestInit): Promise<Answer>;
  close(): Promise<void>;
}

/** Starts the API on a free port, with one run already in the database. */
export async function harness(
  seed: Parameters<typeof seedRun>[1] = {},
): Promise<Harness & { readonly run: SeededRun }> {
  const db = new FakeDatabase();
  const run = seedRun(db, seed);
  const app = await listen(participationApp(db));

  return {
    db,
    app,
    run,
    request: (path, init) => send(app, path, init ?? {}),
    close: () => app.close(),
  };
}

/** Puts a student in a run, the way the student app does. */
export async function join(
  harnessed: Harness,
  over: {
    readonly joinCode?: string;
    readonly displayName?: string;
    readonly deviceId?: string;
  } = {},
): Promise<Answer> {
  return harnessed.request(
    '/join',
    anonymous({
      joinCode: over.joinCode ?? CODE_A,
      displayName: over.displayName ?? 'Sam',
      deviceId: over.deviceId ?? 'phone-1',
    }),
  );
}

/** The id of the participant a join answered with. */
export function participantIdOf(answer: Answer): string {
  return String((answer.body['participant'] as Record<string, unknown>)['id']);
}

/** Adds a team to a run, as a teacher. */
export async function createTeam(
  harnessed: Harness,
  name: string,
  options: { readonly sessionId?: string; readonly bearer?: string } = {},
): Promise<Answer> {
  return harnessed.request(
    `/sessions/${options.sessionId ?? RUN_A}/teams`,
    as(options.bearer ?? token(ORG_A), { method: 'POST', body: { name } }),
  );
}

/** The rows one table holds, for a test that asserts on stored state. */
export function rowsIn(harnessed: Harness, table: string): readonly FakeRow[] {
  return harnessed.db.rowsIn(table);
}

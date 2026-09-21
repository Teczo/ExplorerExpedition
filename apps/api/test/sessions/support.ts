/**
 * Standing the run lifecycle endpoints up, for EXPD-019's tests.
 *
 * The tests here send real requests with real tokens, for the reason
 * EXPD-017's and EXPD-018's do: a good deal of what this ticket promises is
 * about the stack in front of the handler rather than the handler itself.
 * Another organisation's run is not found, a student's phone cannot start a
 * lesson, `session:control` is a different permission from `session:write`,
 * and the entry in the audit log names whoever really called. A test that
 * called the service directly would prove none of that.
 *
 * Unlike EXPD-018, runs are *made* through the endpoint rather than seeded,
 * because making one is this ticket's. What is seeded is what a run is made
 * against: an expedition and a published revision of it, which is EXPD-017's
 * and is already tested there.
 *
 * A seeded run is still needed for the states a run cannot be talked into
 * from outside in one step — a run that started an hour ago, a run that has
 * been paused for five minutes — so `seedRun` writes one at whatever point of
 * its life a test needs it at.
 */

import type { Express } from 'express';
import type { JsonObject, OrganisationId, TimingRules } from '@explorer/shared-types';

import { createApp } from '../../src/app.ts';
import { signAccessToken, signingKey } from '../../src/auth/tokens.ts';
import { DEFAULT_LIFETIMES, type AuthConfig } from '../../src/config/auth-config.ts';
import { FakeDatabase, type FakeRow } from '../support/fake-database.ts';
import { ORG_A, ORG_B } from '../support/organisations.ts';
import { listen, send, type Answer, type RunningApp } from '../http/support.ts';

export { ORG_A, ORG_B };

/** The settings the tests sign their own tokens with. */
export const CONFIG: AuthConfig = {
  signingKey: signingKey('e'.repeat(32)),
  lifetimes: DEFAULT_LIFETIMES,
};

/** The staff account most of these tests act as. */
export const TEACHER = '66666666-6666-4666-8666-666666666666';

/** Portside School's expedition, the one runs are made of. */
export const EXPEDITION_A = 'a0000000-0000-4000-8000-0000000000e1';

/** Riverbank Academy's. A test must never reach it. */
export const EXPEDITION_B = 'b0000000-0000-4000-8000-0000000000e2';

/** The published revision of `EXPEDITION_A`. */
export const VERSION_A = 'a0000000-0000-4000-8000-0000000000v1'.replace(/v/gu, '9');

/** The published revision of `EXPEDITION_B`. */
export const VERSION_B = 'b0000000-0000-4000-8000-0000000000v2'.replace(/v/gu, '9');

/** A seeded run of Portside School's expedition. */
export const RUN_A = 'a0000000-0000-4000-8000-00000000aaaa';

/** A seeded run of Riverbank Academy's. A test must never reach it. */
export const RUN_B = 'b0000000-0000-4000-8000-00000000bbbb';

/** An id no row has. */
export const MISSING_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** A time every seeded run is dated from, so a test can do the arithmetic. */
export const NOON = new Date('2026-03-03T12:00:00.000Z');

/** The whole API, with a database that keeps its rows in memory. */
export function sessionApp(db: FakeDatabase): Express {
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

/** A token for a student's phone, which may do none of this. */
export function deviceToken(
  organisationId: OrganisationId | string,
  sessionId: string = RUN_A,
): string {
  return signAccessToken(
    CONFIG.signingKey,
    {
      sub: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      aud: 'device',
      org: organisationId,
      ses: sessionId,
      dev: '88888888-8888-4888-8888-888888888888',
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

/** The timing a seeded expedition plays by when a test does not say otherwise. */
export const DEFAULT_TIMING: TimingRules = {
  startMode: 'synchronised',
  endMode: 'teacher-ends',
};

/**
 * A document with nothing in it but the timing.
 *
 * `timingRulesOf` reads `rules.timing` and nothing else, so a fixture that
 * carried a whole valid expedition would only be saying at greater length
 * that this ticket ignores the rest of it.
 */
export function definitionWith(timing: Partial<TimingRules> = {}): JsonObject {
  const rules = { ...DEFAULT_TIMING, ...timing };
  return {
    schemaVersion: '1.1.0',
    rules: {
      timing: {
        startMode: rules.startMode,
        endMode: rules.endMode,
        ...(rules.totalTimeLimitSeconds === undefined
          ? {}
          : { totalTimeLimitSeconds: rules.totalTimeLimitSeconds }),
        ...(rules.countdownSeconds === undefined
          ? {}
          : { countdownSeconds: rules.countdownSeconds }),
      },
    },
  };
}

/** Writes an expedition and one published revision of it. */
export function seedExpedition(
  db: FakeDatabase,
  over: {
    readonly expeditionId?: string;
    readonly versionId?: string;
    readonly organisationId?: string;
    readonly timing?: Partial<TimingRules>;
    /** `draft` for an expedition nothing has been published from. */
    readonly versionStatus?: string;
  } = {},
): { readonly expeditionId: string; readonly versionId: string } {
  const expeditionId = over.expeditionId ?? EXPEDITION_A;
  const versionId = over.versionId ?? VERSION_A;
  const organisationId = over.organisationId ?? ORG_A;

  db.seed('expedition', {
    id: expeditionId,
    organisation_id: organisationId,
    status: 'published',
    source: 'studio',
    created_at: NOON,
    updated_at: NOON,
  });

  db.seed('expedition_version', {
    id: versionId,
    organisation_id: organisationId,
    expedition_id: expeditionId,
    definition_version: 1,
    schema_version: '1.1.0',
    status: over.versionStatus ?? 'published',
    definition: definitionWith(over.timing ?? {}),
    title: 'The River Trail',
    summary: '',
    locale: 'en-GB',
    created_at: NOON,
    updated_at: NOON,
  });

  return { expeditionId, versionId };
}

/** What one seeded run is made of. */
export interface SeededRun {
  readonly sessionId: string;
  readonly organisationId: string;
  readonly joinCode: string;
}

/**
 * Writes a run at whatever point of its life a test needs it at.
 *
 * The clock columns are written as they are given, so a test can ask for a
 * run that started an hour ago or one that has been paused for five minutes
 * without pressing the buttons that would get it there.
 */
export function seedRun(
  db: FakeDatabase,
  over: {
    readonly sessionId?: string;
    readonly expeditionId?: string;
    readonly versionId?: string;
    readonly organisationId?: string;
    readonly joinCode?: string;
    readonly status?: string;
    readonly startedAt?: Date | null;
    readonly pausedAt?: Date | null;
    readonly pausedSecondsTotal?: number;
    readonly extendedSecondsTotal?: number;
    readonly endedAt?: Date | null;
  } = {},
): SeededRun {
  const sessionId = over.sessionId ?? RUN_A;
  const organisationId = over.organisationId ?? ORG_A;
  const joinCode = over.joinCode ?? 'HJ4KMN';

  db.seed('expedition_session', {
    id: sessionId,
    organisation_id: organisationId,
    expedition_id: over.expeditionId ?? EXPEDITION_A,
    expedition_version_id: over.versionId ?? VERSION_A,
    name: 'Year 6 — Tuesday',
    join_code: joinCode,
    status: over.status ?? 'lobby',
    host_user_id: TEACHER,
    scheduled_start_at: null,
    started_at: over.startedAt ?? null,
    paused_at: over.pausedAt ?? null,
    paused_seconds_total: over.pausedSecondsTotal ?? 0,
    extended_seconds_total: over.extendedSecondsTotal ?? 0,
    ended_at: over.endedAt ?? null,
    created_by: TEACHER,
    created_at: NOON,
    updated_at: NOON,
  });

  return { sessionId, organisationId, joinCode };
}

/** A running API, and the calls a test makes against it. */
export interface Harness {
  readonly db: FakeDatabase;
  readonly app: RunningApp;
  request(path: string, init?: RequestInit): Promise<Answer>;
  close(): Promise<void>;
}

/** Starts the API on a free port, with one published expedition to run. */
export async function harness(
  seed: Parameters<typeof seedExpedition>[1] = {},
): Promise<Harness> {
  const db = new FakeDatabase();
  seedExpedition(db, seed);
  const app = await listen(sessionApp(db));

  return {
    db,
    app,
    request: (path, init) => send(app, path, init ?? {}),
    close: () => app.close(),
  };
}

/** Schedules a run through the endpoint, as a teacher would. */
export async function schedule(
  harnessed: Harness,
  body: Record<string, unknown> = {},
  options: { readonly bearer?: string } = {},
): Promise<Answer> {
  return harnessed.request(
    '/sessions',
    as(options.bearer ?? token(ORG_A), {
      method: 'POST',
      body: { expeditionId: EXPEDITION_A, ...body },
    }),
  );
}

/** Presses one of the five buttons on a run. */
export async function command(
  harnessed: Harness,
  sessionId: string,
  verb: 'start' | 'pause' | 'resume' | 'extend' | 'end',
  options: { readonly bearer?: string; readonly body?: unknown } = {},
): Promise<Answer> {
  return harnessed.request(
    `/sessions/${sessionId}/${verb}`,
    as(options.bearer ?? token(ORG_A), {
      method: 'POST',
      ...(options.body === undefined ? {} : { body: options.body }),
    }),
  );
}

/** The id of the run a schedule answered with. */
export function sessionIdOf(answer: Answer): string {
  return String(answer.body['id']);
}

/** The clock out of one answer. */
export function clockOf(answer: Answer): Record<string, unknown> {
  return answer.body['clock'] as Record<string, unknown>;
}

/** The rows one table holds, for a test that asserts on stored state. */
export function rowsIn(harnessed: Harness, table: string): readonly FakeRow[] {
  return harnessed.db.rowsIn(table);
}

/** The one run row a test seeded or made, read back out of the store. */
export function runRow(harnessed: Harness, sessionId: string): FakeRow {
  const row = rowsIn(harnessed, 'expedition_session').find(
    (stored) => stored['id'] === sessionId,
  );
  if (row === undefined) {
    throw new Error(`No run ${sessionId} in the store.`);
  }
  return row;
}

/** Every audit entry of one action, oldest first. */
export function auditOf(harnessed: Harness, action: string): readonly FakeRow[] {
  return rowsIn(harnessed, 'audit_log').filter((row) => row['action'] === action);
}

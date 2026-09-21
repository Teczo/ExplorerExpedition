/**
 * Saying whether the API is alive, and whether it can do its job (EXPD-016).
 *
 * Two different questions, and answering them with one endpoint is how an
 * outage gets worse. So there are two:
 *
 *   GET /health         Is this process alive? Always 200 while it is.
 *   GET /health/ready   Can it serve a real request? 200, or 503.
 *
 * `/health` is what App Service probes (EXPD-007: `healthCheckPath` in
 * `infra/modules/app-service.bicep`) and what `scripts/package-api.sh` asks
 * the built package before it ships it. It touches nothing outside the
 * process, because a liveness probe that fails when the database is slow
 * tells the platform to restart every instance at exactly the moment
 * restarting helps least.
 *
 * `/health/ready` is the one a person or a deploy script reads. It asks the
 * database whether it is there, and answers 503 when it is not. Nothing
 * routes traffic on it today.
 *
 * Neither needs a token. They say nothing a caller could not learn by sending
 * a request and watching it fail, and a probe cannot hold credentials.
 */

import { Router } from 'express';
import { ENGINE_VERSION } from '@explorer/engine';

import type { Queryable } from '../db/queryable.ts';

/** What the health endpoints can be given. */
export interface HealthOptions {
  /**
   * The database to ask about. Absent when the app was built without one, and
   * then the readiness check reports it as `not-configured` rather than
   * failing: an API with no database is a deliberate arrangement here, not a
   * broken one.
   */
  readonly db?: Queryable;
  /** The version of the API itself. Defaults to the package's. */
  readonly apiVersion?: string;
  /** How long to wait for the database before calling it unreachable. */
  readonly readinessTimeoutMs?: number;
  /** For tests. Defaults to `process.uptime`. */
  readonly uptimeSeconds?: () => number;
}

/** How long the readiness check waits for the database. */
export const DEFAULT_READINESS_TIMEOUT_MS = 2000;

/** What one dependency has to say for itself. */
export type CheckStatus = 'ok' | 'failed' | 'not-configured';

/** The body `/health` answers with. */
export interface LivenessBody {
  readonly status: 'ok';
  readonly apiVersion: string;
  readonly engineVersion: string;
  readonly uptimeSeconds: number;
}

/** The body `/health/ready` answers with. */
export interface ReadinessBody {
  readonly status: 'ok' | 'unavailable';
  readonly apiVersion: string;
  readonly engineVersion: string;
  readonly uptimeSeconds: number;
  readonly checks: Readonly<Record<string, CheckStatus>>;
}

/**
 * Builds the health endpoints.
 *
 * Mounted at the root, so the paths are `/health` and `/health/ready`. They
 * sit in front of everything else in `createApp`, because a probe should not
 * wait behind a body parser or an authentication check.
 */
export function createHealthRouter(options: HealthOptions = {}): Router {
  const router = Router();
  const apiVersion = options.apiVersion ?? API_VERSION;
  const uptime = options.uptimeSeconds ?? (() => process.uptime());
  const timeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;

  const liveness = (): LivenessBody => ({
    status: 'ok',
    apiVersion,
    engineVersion: ENGINE_VERSION,
    uptimeSeconds: Math.round(uptime()),
  });

  router.get('/health', (_request, response) => {
    response.status(200).json(liveness());
  });

  // The same answer under the name a reader expects to find next to
  // `/health/ready`. Nothing probes it; it is here so that the pair reads as a
  // pair.
  router.get('/health/live', (_request, response) => {
    response.status(200).json(liveness());
  });

  router.get('/health/ready', async (_request, response) => {
    const database = await databaseStatus(options.db, timeoutMs);
    const checks: Record<string, CheckStatus> = { database };
    const ready = Object.values(checks).every((status) => status !== 'failed');

    response.status(ready ? 200 : 503).json({
      ...liveness(),
      status: ready ? 'ok' : 'unavailable',
      checks,
    } satisfies ReadinessBody);
  });

  return router;
}

/**
 * The version of the API's own contract.
 *
 * Not the package version and not a route prefix. It is here so that a client
 * looking at a running instance can tell what it is talking to; when the API
 * gains a versioned route prefix, this is what it will be named for.
 */
export const API_VERSION = '0.1.0';

/**
 * Asks the database whether it is there.
 *
 * `SELECT 1` and nothing else: it proves a connection can be had and a
 * statement can run, and it reads no row, so it cannot be slow because of
 * data. The timeout is the point — without one this endpoint hangs exactly
 * when the thing it reports on has stopped answering.
 */
async function databaseStatus(
  db: Queryable | undefined,
  timeoutMs: number,
): Promise<CheckStatus> {
  if (db === undefined) {
    return 'not-configured';
  }

  try {
    await withTimeout(db.query('SELECT 1'), timeoutMs);
    return 'ok';
  } catch {
    // Deliberately says nothing about why. A readiness endpoint is open to
    // anybody, and the reason belongs in the log, not in the answer.
    return 'failed';
  }
}

/** Rejects if `work` has not finished within `timeoutMs`. */
async function withTimeout<TResult>(
  work: Promise<TResult>,
  timeoutMs: number,
): Promise<TResult> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    // A pending timer must not be what keeps the process alive.
    timer.unref?.();
  });

  try {
    return await Promise.race([work, expiry]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

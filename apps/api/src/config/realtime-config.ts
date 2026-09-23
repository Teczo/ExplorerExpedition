/**
 * Where the realtime channel fans out from (EXPD-023).
 *
 *   REDIS_URL    `rediss://:<key>@<host>:6380`, as EXPD-007 writes it.
 *
 * Allowed to be missing. Without it the API uses the in-process broker,
 * which is right for one instance on its own — a developer's machine, a
 * test — and wrong for more than one: a phone on one instance would not
 * hear a teacher on another. EXPD-007 always sets it on App Service.
 *
 * A value that is set but cannot be read is refused when the app is built,
 * rather than turning into thirty phones that never hear a thing.
 */

import { parseRedisUrl, type RedisEndpoint } from '../realtime/redis-broker.ts';

/** Reads `REDIS_URL`, or returns undefined when it is not set. */
export function readRealtimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): RedisEndpoint | undefined {
  const url = environment['REDIS_URL']?.trim();
  if (url === undefined || url === '') {
    return undefined;
  }
  return parseRedisUrl(url);
}

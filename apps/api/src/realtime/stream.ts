/**
 * One open stream, as Server-Sent Events (EXPD-023).
 *
 * **Why SSE and not WebSockets.** Everything the channel carries goes one
 * way, from the API to a client; everything a client does is already a REST
 * call with its own validation, permission and audit entry. SSE is plain
 * HTTP, so the stack in front of every other route — the token, the
 * permission, the organisation — stands in front of this one unchanged, and
 * it needs no dependency: a WebSocket server does. App Service passes a
 * streamed response through as it is.
 *
 * The wire format, one event:
 *
 *     id: 6f1c…
 *     event: session.status
 *     data: {"type":"session.status","status":"paused",…}
 *
 * Every event's `data` repeats its `type`, so a client that reads the stream
 * with `fetch` rather than `EventSource` has one thing to parse.
 *
 * **A stream ends when its token does.** The token is checked once, when the
 * stream opens, so a stream is closed at the token's `exp`. A client opens a
 * new one with a fresh token, and a revoked sign-in stops hearing a run no
 * later than its last token runs out.
 */

import type { Response } from 'express';
import type { RealtimeEvent, SessionStatus } from '@explorer/shared-types';

import type { RealtimeHub, RunTarget, StreamListener, Viewer } from './hub.ts';

/** How often a comment line is sent, so no proxy decides the stream is idle. */
export const HEARTBEAT_SECONDS = 25;

/** How long `EventSource` should wait before reconnecting, in milliseconds. */
export const RECONNECT_MILLISECONDS = 3_000;

/** What opening a stream needs. */
export interface OpenStreamOptions {
  readonly hub: RealtimeHub;
  readonly target: RunTarget;
  readonly viewer: Viewer;
  /** The run's status as the stream opens. Sent on `channel.ready`. */
  readonly sessionStatus: SessionStatus;
  /** When the caller's token runs out. The stream is closed then. */
  readonly expiresAt: Date | undefined;
  readonly now?: () => Date;
  readonly heartbeatSeconds?: number;
  /** Where a stream that could not be attached is reported. */
  readonly log?: (message: string, error?: unknown) => void;
}

/**
 * Turns an Express response into a stream, and attaches it to the hub.
 *
 * Resolves once the stream is attached and `channel.ready` has been sent.
 * Everything after that happens as events arrive, until the client goes
 * away, the token runs out, or the student is taken out of the run.
 */
export async function openStream(response: Response, options: OpenStreamOptions): Promise<void> {
  const { hub, target, viewer } = options;
  const now = options.now ?? (() => new Date());
  const heartbeatSeconds = options.heartbeatSeconds ?? HEARTBEAT_SECONDS;
  let status = options.sessionStatus;
  let closed = false;
  let detach: (() => Promise<void>) | undefined;

  const write = (event: RealtimeEvent): void => {
    if (closed) {
      return;
    }
    if (event.type === 'session.status') {
      status = event.status;
    }
    response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };

  const ready = (): void => {
    write(
      hub.stamp(target.sessionId, {
        type: 'channel.ready',
        sessionStatus: status,
        teamId: viewer.kind === 'device' ? viewer.teamId : null,
        heartbeatSeconds,
      }),
    );
  };

  const heartbeat = setInterval(() => {
    if (!closed) {
      response.write(': heartbeat\n\n');
    }
  }, heartbeatSeconds * 1000);
  heartbeat.unref();

  let expiry: NodeJS.Timeout | undefined;
  if (options.expiresAt !== undefined) {
    const remaining = Math.max(0, options.expiresAt.getTime() - now().getTime());
    expiry = setTimeout(() => finish(), remaining);
    expiry.unref();
  }

  const finish = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(expiry);
    void detach?.();
    response.end();
  };

  response.on('close', finish);

  response.status(200);
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  // A stream is never cached, and never held back by a proxy that buffers.
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('X-Accel-Buffering', 'no');
  response.flushHeaders();
  response.write(`retry: ${RECONNECT_MILLISECONDS}\n\n`);

  // Events that arrive before `channel.ready` has gone out wait for it, so
  // that it is always the first event on a stream.
  let pending: RealtimeEvent[] | undefined = [];
  const listener: StreamListener = {
    viewer,
    deliver: (event) => (pending === undefined ? write(event) : pending.push(event)),
    // After a gap, staff are told to read again. A phone's stream is closed
    // instead: a `participant.team-changed` may have been lost in the gap, and
    // reconnecting is what reads its team again.
    resync: viewer.kind === 'device' ? () => finish() : ready,
    end: finish,
  };

  try {
    detach = await hub.attach(target, listener);
  } catch (error) {
    // The headers are gone, so the error contract cannot be used. The client
    // sees the stream close and reconnects after `retry`.
    (options.log ?? console.error)(`[realtime] could not attach a stream to run ${target.sessionId}`, error);
    finish();
    return;
  }
  if (closed) {
    // The client went away while the subscription was being made.
    await detach();
    return;
  }
  ready();
  const waiting = pending;
  pending = undefined;
  for (const event of waiting) {
    write(event);
  }
}

/**
 * When a bearer token runs out, read from its `exp` claim.
 *
 * Only for a token `authenticate` has already verified: nothing here checks
 * the signature. Undefined when the claim cannot be read.
 */
export function tokenExpiresAt(token: string | null): Date | undefined {
  if (token === null) {
    return undefined;
  }
  const payload = token.split('.')[1];
  if (payload === undefined) {
    return undefined;
  }
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    return typeof claims.exp === 'number' ? new Date(claims.exp * 1000) : undefined;
  } catch {
    return undefined;
  }
}

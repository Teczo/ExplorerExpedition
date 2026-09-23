/**
 * Standing the realtime channel up, for EXPD-023's tests.
 *
 * Two things a test needs and nothing in the repository had:
 *
 *   - **A stream reader.** `openStream` holds a real HTTP request open and
 *     reads its body as Server-Sent Events, the way the student app will.
 *   - **A Redis.** `FakeRedis` is a TCP server that speaks enough RESP2 —
 *     `AUTH`, `PING`, `PUBLISH`, `SUBSCRIBE`, `UNSUBSCRIBE` — to hold two
 *     brokers to account, and can drop every connection on demand.
 *
 * The runs, teams and students come from EXPD-020's play fixture, because
 * it is the one fixture every router that tells the channel something can
 * work on: a run under way, Red (Asha, Ben), Blue (Cal), Dev on no team,
 * and Eve taken out of the run.
 */

import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import type { RealtimeEvent } from '@explorer/shared-types';

import { createApp, type AppOptions } from '../../src/app.ts';
import type { RealtimeBroker } from '../../src/realtime/broker.ts';
import { encodeCommand, RespParser, type RespValue } from '../../src/realtime/resp.ts';
import { signAccessToken } from '../../src/auth/tokens.ts';
import { FakeDatabase } from '../support/fake-database.ts';
import { listen, send, type Answer, type RunningApp } from '../http/support.ts';
import {
  CONFIG,
  codeMatch,
  seed,
  ORG_A as ORGANISATION,
  RUN_A,
  type FixtureOptions,
} from '../play/support.ts';

export {
  ASHA,
  BEN,
  CAL,
  DEV,
  EVE,
  ORG_A,
  ORG_B,
  RUN_A,
  RUN_A2,
  RUN_B,
  TEAM_BLUE,
  TEAM_RED,
  MISSING_ID,
  phone,
  staff,
} from '../play/support.ts';

/** How long a test waits for an event before it fails. */
const WAIT_MS = 2_000;

// --- Reading a stream ------------------------------------------------------

/** One open stream, as a client reads it. */
export interface OpenedStream {
  readonly status: number;
  readonly headers: Headers;
  /** Every event so far, oldest first. */
  readonly events: RealtimeEvent[];
  /** Every comment line so far. */
  readonly comments: string[];
  /** Resolves when the server ends the stream. */
  readonly ended: Promise<void>;
  /** The next event of this type after the ones already taken, waiting if need be. */
  next(type: RealtimeEvent['type']): Promise<RealtimeEvent>;
  /** Events of this type so far. */
  all(type: RealtimeEvent['type']): RealtimeEvent[];
  /** Hangs up. */
  close(): void;
}

/** The body of a refused stream, when it was refused before it began. */
export interface RefusedStream {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/**
 * Opens `GET /sessions/:id/events`.
 *
 * Answers with an `OpenedStream` when the server started streaming, and a
 * `RefusedStream` when it answered with the ordinary error contract.
 */
export async function openStream(
  app: RunningApp,
  bearer: string | null,
  sessionId: string = RUN_A,
): Promise<OpenedStream | RefusedStream> {
  const abort = new AbortController();
  const response = await fetch(`${app.url}/sessions/${sessionId}/events`, {
    headers: bearer === null ? {} : { authorization: `Bearer ${bearer}` },
    signal: abort.signal,
  });
  if (!(response.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
    const text = await response.text();
    return { status: response.status, body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const events: RealtimeEvent[] = [];
  const comments: string[] = [];
  const taken = new Map<string, number>();
  const waiters = new Set<() => void>();
  const wake = (): void => {
    for (const waiter of [...waiters]) {
      waiter();
    }
  };

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const ended = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let split: number;
        while ((split = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          let data: string | undefined;
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) {
              comments.push(line.slice(1).trim());
            } else if (line.startsWith('data: ')) {
              data = line.slice('data: '.length);
            }
          }
          if (data !== undefined) {
            events.push(JSON.parse(data) as RealtimeEvent);
          }
        }
        wake();
      }
    } catch {
      // Aborted by `close()`.
    } finally {
      wake();
    }
  })();

  let finished = false;
  void ended.then(() => {
    finished = true;
  });

  return {
    status: response.status,
    headers: response.headers,
    events,
    comments,
    ended,
    all: (type) => events.filter((event) => event.type === type),
    next(type) {
      return new Promise<RealtimeEvent>((resolve, reject) => {
        const look = (): boolean => {
          const from = taken.get(type) ?? 0;
          const matching = events.filter((event) => event.type === type);
          const found = matching[from];
          if (found !== undefined) {
            taken.set(type, from + 1);
            resolve(found);
            return true;
          }
          if (finished) {
            reject(new Error(`the stream ended before a ${type} arrived`));
            return true;
          }
          return false;
        };
        if (look()) {
          return;
        }
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`no ${type} within ${WAIT_MS} ms; had ${events.map((e) => e.type).join(', ')}`));
        }, WAIT_MS);
        const waiter = (): void => {
          if (look()) {
            clearTimeout(timer);
            waiters.delete(waiter);
          }
        };
        waiters.add(waiter);
      });
    },
    close: () => abort.abort(),
  };
}

/** Narrows a stream answer to one that opened, or fails the test. */
export function opened(answer: OpenedStream | RefusedStream): OpenedStream {
  if (!('events' in answer)) {
    throw new Error(`the stream was refused with ${answer.status}: ${JSON.stringify(answer.body)}`);
  }
  return answer;
}

// --- The API ---------------------------------------------------------------

/** A running API over the play fixture, and the calls a test makes against it. */
export interface Harness {
  readonly db: FakeDatabase;
  readonly app: RunningApp;
  stream(bearer: string | null, sessionId?: string): Promise<OpenedStream | RefusedStream>;
  post(path: string, bearer: string, body?: unknown): Promise<Answer>;
  put(path: string, bearer: string, body: unknown): Promise<Answer>;
  delete(path: string, bearer: string): Promise<Answer>;
  close(): Promise<void>;
}

/** Starts the API over the play fixture. Streams opened through it are closed by `close`. */
export async function harness(
  options: Partial<AppOptions> & { readonly db?: FakeDatabase; readonly realtimeBroker?: RealtimeBroker } = {},
): Promise<Harness> {
  const db = options.db ?? seeded();
  const app = await listen(
    createApp({ authConfig: CONFIG, missionTypes: [codeMatch], ...options, db }),
  );
  const streams: OpenedStream[] = [];

  const call = (method: string, path: string, bearer: string, body?: unknown): Promise<Answer> =>
    send(app, path, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  return {
    db,
    app,
    async stream(bearer, sessionId = RUN_A) {
      const answer = await openStream(app, bearer, sessionId);
      if ('events' in answer) {
        streams.push(answer);
      }
      return answer;
    },
    post: (path, bearer, body) => call('POST', path, bearer, body),
    put: (path, bearer, body) => call('PUT', path, bearer, body),
    delete: (path, bearer) => call('DELETE', path, bearer),
    async close() {
      for (const stream of streams) {
        stream.close();
      }
      await Promise.all(streams.map((stream) => stream.ended));
      await app.close();
    },
  };
}

/** A fresh database with the play fixture in it. */
export function seeded(options: FixtureOptions = {}): FakeDatabase {
  const db = new FakeDatabase();
  seed(db, options);
  return db;
}

/** A phone token that runs out in `seconds`. */
export function shortPhone(participantId: string, seconds: number): string {
  return signAccessToken(
    CONFIG.signingKey,
    {
      sub: participantId,
      aud: 'device',
      org: ORGANISATION,
      ses: RUN_A,
      dev: '88888888-8888-4888-8888-888888888888',
    },
    seconds,
  );
}

// --- A Redis ---------------------------------------------------------------

/** Enough of Redis to hold a broker to account. */
export class FakeRedis {
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();
  readonly #subscriptions = new Map<Socket, Set<string>>();
  readonly #password: string | undefined;
  /** Every command received, as its words. */
  readonly commands: string[][] = [];
  port = 0;

  constructor(options: { readonly password?: string } = {}) {
    this.#password = options.password;
    this.#server = createServer((socket) => this.#accept(socket));
  }

  /** Listens on `port`, or on one the operating system picks. */
  async start(port = 0): Promise<this> {
    await new Promise<void>((resolve) => this.#server.listen(port, '127.0.0.1', resolve));
    this.port = (this.#server.address() as AddressInfo).port;
    return this;
  }

  /** Drops every connection, the way a failover does. */
  dropAll(): void {
    for (const socket of this.#sockets) {
      socket.destroy();
    }
  }

  /** How many sockets are subscribed to a channel. */
  subscribers(channel: string): number {
    let count = 0;
    for (const channels of this.#subscriptions.values()) {
      if (channels.has(channel)) {
        count += 1;
      }
    }
    return count;
  }

  async stop(): Promise<void> {
    this.dropAll();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  #accept(socket: Socket): void {
    this.#sockets.add(socket);
    const parser = new RespParser();
    let authed = this.#password === undefined;
    socket.on('error', () => undefined);
    socket.on('close', () => {
      this.#sockets.delete(socket);
      this.#subscriptions.delete(socket);
    });
    socket.on('data', (chunk: Buffer) => {
      for (const value of parser.feed(chunk)) {
        const words = (value as RespValue[]).map(String);
        this.commands.push(words);
        const [name = '', ...args] = words;
        const command = name.toUpperCase();

        if (command === 'AUTH') {
          const offered = args[args.length - 1];
          authed = offered === this.#password;
          socket.write(authed ? '+OK\r\n' : '-WRONGPASS invalid username-password pair\r\n');
          continue;
        }
        if (!authed) {
          socket.write('-NOAUTH Authentication required.\r\n');
          continue;
        }
        switch (command) {
          case 'PING':
            socket.write(
              this.#subscriptions.has(socket) ? encodeArray(['pong', '']) : '+PONG\r\n',
            );
            break;
          case 'PUBLISH': {
            const [channel = '', message = ''] = args;
            let delivered = 0;
            for (const [subscriber, channels] of this.#subscriptions) {
              if (channels.has(channel)) {
                subscriber.write(encodeArray(['message', channel, message]));
                delivered += 1;
              }
            }
            socket.write(`:${delivered}\r\n`);
            break;
          }
          case 'SUBSCRIBE': {
            const channels = this.#subscriptions.get(socket) ?? new Set<string>();
            this.#subscriptions.set(socket, channels);
            for (const channel of args) {
              channels.add(channel);
              socket.write(encodeArray(['subscribe', channel, channels.size]));
            }
            break;
          }
          case 'UNSUBSCRIBE': {
            const channels = this.#subscriptions.get(socket) ?? new Set<string>();
            for (const channel of args) {
              channels.delete(channel);
              socket.write(encodeArray(['unsubscribe', channel, channels.size]));
            }
            break;
          }
          default:
            socket.write(`-ERR unknown command '${name}'\r\n`);
        }
      }
    });
  }
}

/** A push array, with the count as an integer the way Redis sends it. */
function encodeArray(items: readonly (string | number)[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${items.length}\r\n`)];
  for (const item of items) {
    if (typeof item === 'number') {
      parts.push(Buffer.from(`:${item}\r\n`));
    } else {
      parts.push(encodeCommand([item]).subarray(`*1\r\n`.length));
    }
  }
  return Buffer.concat(parts);
}

/** Waits until a condition holds, or fails. */
export async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

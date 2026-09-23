/**
 * Redis pub/sub as a broker (EXPD-023).
 *
 * Every instance of the API holds two connections to the cache EXPD-007
 * deployed:
 *
 *   - **one to publish on.** `PUBLISH` is an ordinary command with an
 *     ordinary reply.
 *   - **one to subscribe on.** A connection that has sent `SUBSCRIBE` may
 *     send nothing but more subscriptions, so it cannot be the first one.
 *
 * Both are opened when first needed, not when the app is built: an API that
 * nobody has asked for a stream is not holding a socket to Redis.
 *
 * **Losing Redis loses events, not records.** Everything the channel carries
 * was committed to PostgreSQL before it was published. When the subscribing
 * connection drops, it is opened again with a growing delay and every channel
 * is subscribed again; whatever was published in the gap is gone, so the hub
 * is told (`onGap`) and tells every client listening to read again. A publish
 * while Redis is down fails, and the caller logs it.
 *
 * EXPD-007 writes `REDIS_URL` as `rediss://:<key>@<host>:6380`. TLS is not
 * optional there — the plain port is off — and this reads either scheme so
 * that a local Redis works too.
 */

import { connect as connectTcp, type Socket } from 'node:net';
import { connect as connectTls } from 'node:tls';

import type { BrokerListener, RealtimeBroker } from './broker.ts';
import { encodeCommand, RespError, RespParser, type RespValue } from './resp.ts';

/** Where Redis is, and how to sign in to it. */
export interface RedisEndpoint {
  readonly host: string;
  readonly port: number;
  readonly tls: boolean;
  readonly username?: string;
  readonly password?: string;
}

/** Opens the socket. Tests pass their own. */
export type RedisConnector = (endpoint: RedisEndpoint) => Socket;

/** What the broker can be given. */
export interface RedisBrokerOptions {
  readonly endpoint: RedisEndpoint;
  readonly connect?: RedisConnector;
  /** Where a lost connection is reported. Defaults to `console.error`. */
  readonly log?: (message: string, error?: unknown) => void;
  /** How long to wait before each attempt to reconnect, in milliseconds. The last one repeats. */
  readonly retryDelaysMs?: readonly number[];
  /** How long a connection or a reply may take, in milliseconds. */
  readonly timeoutMs?: number;
  /** How often the subscribing connection sends `PING`, in milliseconds. */
  readonly pingIntervalMs?: number;
}

const DEFAULT_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000, 10_000];
const DEFAULT_TIMEOUT_MS = 5_000;
/** Well inside the ten idle minutes after which Azure closes a connection. */
const DEFAULT_PING_INTERVAL_MS = 60_000;

/** Reads `redis://` and `rediss://` URLs. Throws on anything else. */
export function parseRedisUrl(value: string): RedisEndpoint {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('REDIS_URL is not a URL.');
  }
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error('REDIS_URL has to start with redis:// or rediss://.');
  }
  if (url.hostname === '') {
    throw new Error('REDIS_URL names no host.');
  }
  const tls = url.protocol === 'rediss:';
  const port = url.port === '' ? (tls ? 6380 : 6379) : Number(url.port);
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  return {
    host: url.hostname,
    port,
    tls,
    ...(username === '' ? {} : { username }),
    ...(password === '' ? {} : { password }),
  };
}

/** The socket a real deployment opens. */
export function defaultRedisConnector(endpoint: RedisEndpoint): Socket {
  return endpoint.tls
    ? connectTls({ host: endpoint.host, port: endpoint.port, servername: endpoint.host })
    : connectTcp({ host: endpoint.host, port: endpoint.port });
}

/** Subscribers of one channel, and who to tell when events may have been missed. */
interface ChannelListeners {
  readonly listeners: Set<BrokerListener>;
  readonly gaps: Set<() => void>;
}

/** A broker that fans out through Redis. */
export class RedisBroker implements RealtimeBroker {
  readonly #endpoint: RedisEndpoint;
  readonly #connect: RedisConnector;
  readonly #log: (message: string, error?: unknown) => void;
  readonly #retryDelaysMs: readonly number[];
  readonly #timeoutMs: number;
  readonly #pingIntervalMs: number;

  readonly #channels = new Map<string, ChannelListeners>();
  /** Channels waiting for Redis to confirm a `SUBSCRIBE`. */
  readonly #confirmations = new Map<string, Array<() => void>>();

  #publisher: Promise<RedisConnection> | undefined;
  #subscriber: Promise<RedisConnection> | undefined;
  #retry = 0;
  #retryTimer: NodeJS.Timeout | undefined;
  #pingTimer: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(options: RedisBrokerOptions) {
    this.#endpoint = options.endpoint;
    this.#connect = options.connect ?? defaultRedisConnector;
    this.#log = options.log ?? ((message, error) => console.error(`[realtime] ${message}`, error ?? ''));
    this.#retryDelaysMs =
      options.retryDelaysMs === undefined || options.retryDelaysMs.length === 0
        ? DEFAULT_RETRY_DELAYS_MS
        : options.retryDelaysMs;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  }

  async publish(channel: string, message: string): Promise<void> {
    this.#assertOpen();
    const connection = await this.#publishingConnection();
    const reply = await connection.command(['PUBLISH', channel, message]);
    if (reply instanceof RespError) {
      throw new Error(`Redis refused PUBLISH: ${reply.message}`);
    }
  }

  async subscribe(
    channel: string,
    listener: BrokerListener,
    onGap?: () => void,
  ): Promise<() => Promise<void>> {
    this.#assertOpen();
    let entry = this.#channels.get(channel);
    const first = entry === undefined;
    if (entry === undefined) {
      entry = { listeners: new Set(), gaps: new Set() };
      this.#channels.set(channel, entry);
    }
    entry.listeners.add(listener);
    if (onGap !== undefined) {
      entry.gaps.add(onGap);
    }

    try {
      const connection = await this.#subscribingConnection();
      if (first) {
        await this.#subscribeOn(connection, channel);
      }
    } catch (error) {
      this.#remove(channel, listener, onGap);
      throw error;
    }

    return async () => {
      if (this.#remove(channel, listener, onGap)) {
        const connection = await this.#subscriber?.catch(() => undefined);
        connection?.send(['UNSUBSCRIBE', channel]);
      }
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#retryTimer);
    clearInterval(this.#pingTimer);
    const connections = await Promise.allSettled([this.#publisher, this.#subscriber]);
    for (const settled of connections) {
      if (settled.status === 'fulfilled') {
        settled.value?.destroy();
      }
    }
    this.#publisher = undefined;
    this.#subscriber = undefined;
    this.#channels.clear();
  }

  /** Takes a listener off a channel. True when nobody is left on it. */
  #remove(channel: string, listener: BrokerListener, onGap?: () => void): boolean {
    const entry = this.#channels.get(channel);
    if (entry === undefined) {
      return false;
    }
    entry.listeners.delete(listener);
    if (onGap !== undefined) {
      entry.gaps.delete(onGap);
    }
    if (entry.listeners.size === 0) {
      this.#channels.delete(channel);
      return true;
    }
    return false;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error('The realtime broker has been closed.');
    }
  }

  #publishingConnection(): Promise<RedisConnection> {
    if (this.#publisher === undefined) {
      const opening = this.#open(false, () => {
        if (this.#publisher === opening) {
          this.#publisher = undefined;
        }
      });
      this.#publisher = opening;
      // A failed open is forgotten, so the next publish tries again.
      opening.catch(() => {
        if (this.#publisher === opening) {
          this.#publisher = undefined;
        }
      });
    }
    return this.#publisher;
  }

  #subscribingConnection(): Promise<RedisConnection> {
    if (this.#subscriber === undefined) {
      const opening = this.#open(true, () => this.#subscriberLost(opening));
      this.#subscriber = opening;
      opening.then(
        () => {
          this.#retry = 0;
          this.#startPing();
        },
        () => this.#subscriberLost(opening),
      );
    }
    return this.#subscriber;
  }

  async #open(subscriber: boolean, onClose: () => void): Promise<RedisConnection> {
    const connection = new RedisConnection({
      socket: this.#connect(this.#endpoint),
      timeoutMs: this.#timeoutMs,
      onPush: subscriber ? (value) => this.#onPush(value) : undefined,
      onClose,
    });
    await connection.ready();
    const { username, password } = this.#endpoint;
    if (password !== undefined) {
      const reply = await connection.command(
        username === undefined ? ['AUTH', password] : ['AUTH', username, password],
      );
      if (reply instanceof RespError) {
        connection.destroy();
        // The reply is Redis's own words; the password is not in them.
        throw new Error(`Redis refused AUTH: ${reply.message}`);
      }
    }
    if (subscriber) {
      connection.enterPushMode();
    }
    return connection;
  }

  /** The subscribing connection closed, or never opened. Try again, later. */
  #subscriberLost(which: Promise<RedisConnection>): void {
    if (this.#subscriber !== which) {
      return;
    }
    this.#subscriber = undefined;
    clearInterval(this.#pingTimer);
    this.#pingTimer = undefined;
    for (const waiting of this.#confirmations.values()) {
      waiting.length = 0;
    }
    this.#confirmations.clear();
    if (this.#closed || this.#channels.size === 0 || this.#retryTimer !== undefined) {
      return;
    }

    const delay = this.#retryDelaysMs[Math.min(this.#retry, this.#retryDelaysMs.length - 1)] ?? 1_000;
    this.#retry += 1;
    this.#log(`lost the Redis subscription; trying again in ${delay} ms`);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      void this.#resubscribe();
    }, delay);
    this.#retryTimer.unref();
  }

  /** Subscribes every channel again, and tells each one it may have missed something. */
  async #resubscribe(): Promise<void> {
    if (this.#closed || this.#channels.size === 0) {
      return;
    }
    const opening = this.#subscribingConnection();
    try {
      const connection = await opening;
      await Promise.all([...this.#channels.keys()].map((channel) => this.#subscribeOn(connection, channel)));
    } catch (error) {
      this.#log('could not subscribe to Redis again', error);
      if (this.#subscriber === opening) {
        (await opening.catch(() => undefined))?.destroy();
      }
      return;
    }
    for (const entry of this.#channels.values()) {
      for (const gap of [...entry.gaps]) {
        gap();
      }
    }
  }

  #subscribeOn(connection: RedisConnection, channel: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.destroy();
        reject(new Error(`Redis did not confirm SUBSCRIBE ${channel}`));
      }, this.#timeoutMs);
      timer.unref();
      const waiting = this.#confirmations.get(channel) ?? [];
      waiting.push(() => {
        clearTimeout(timer);
        resolve();
      });
      this.#confirmations.set(channel, waiting);
      connection.send(['SUBSCRIBE', channel]);
    });
  }

  #startPing(): void {
    clearInterval(this.#pingTimer);
    this.#pingTimer = setInterval(() => {
      void this.#subscriber?.then((connection) => connection.send(['PING'])).catch(() => undefined);
    }, this.#pingIntervalMs);
    this.#pingTimer.unref();
  }

  /** Everything the subscribing connection is sent. */
  #onPush(value: RespValue): void {
    if (!Array.isArray(value) || typeof value[0] !== 'string') {
      return;
    }
    const kind = value[0].toLowerCase();
    const channel = value[1];
    if (typeof channel !== 'string') {
      return;
    }
    if (kind === 'subscribe') {
      const waiting = this.#confirmations.get(channel);
      this.#confirmations.delete(channel);
      for (const resolve of waiting ?? []) {
        resolve();
      }
      return;
    }
    if (kind === 'message' && typeof value[2] === 'string') {
      const message = value[2];
      for (const listener of [...(this.#channels.get(channel)?.listeners ?? [])]) {
        listener(message);
      }
    }
    // `unsubscribe` and `pong` need nothing doing.
  }
}

/** One socket to Redis, with its replies matched to the commands that asked. */
class RedisConnection {
  readonly #socket: Socket;
  readonly #parser = new RespParser();
  readonly #timeoutMs: number;
  readonly #onPush: ((value: RespValue) => void) | undefined;
  readonly #waiting: Array<{
    resolve: (value: RespValue) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  readonly #ready: Promise<void>;
  #pushMode = false;
  #closed = false;

  constructor(options: {
    readonly socket: Socket;
    readonly timeoutMs: number;
    readonly onPush: ((value: RespValue) => void) | undefined;
    readonly onClose: () => void;
  }) {
    this.#socket = options.socket;
    this.#timeoutMs = options.timeoutMs;
    this.#onPush = options.onPush;

    this.#socket.setNoDelay(true);
    this.#socket.setKeepAlive(true, 30_000);

    this.#ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.destroy();
        reject(new Error('Redis did not answer the connection in time'));
      }, this.#timeoutMs);
      timer.unref();
      const event = 'encrypted' in this.#socket ? 'secureConnect' : 'connect';
      this.#socket.once(event, () => {
        clearTimeout(timer);
        resolve();
      });
      this.#socket.once('close', () => {
        clearTimeout(timer);
        reject(new Error('Redis closed the connection'));
      });
    });
    // Whoever awaits `ready()` sees the failure; this stops it being unhandled.
    this.#ready.catch(() => undefined);

    this.#socket.on('data', (chunk: Buffer) => {
      let values: RespValue[];
      try {
        values = this.#parser.feed(chunk);
      } catch {
        this.destroy();
        return;
      }
      for (const value of values) {
        this.#deliver(value);
      }
    });
    // A socket error is always followed by `close`, which is where it is handled.
    this.#socket.on('error', () => undefined);
    this.#socket.once('close', () => {
      this.#closed = true;
      for (const waiting of this.#waiting.splice(0)) {
        clearTimeout(waiting.timer);
        waiting.reject(new Error('Redis closed the connection'));
      }
      options.onClose();
    });
  }

  ready(): Promise<void> {
    return this.#ready;
  }

  /** From here on, everything that arrives is a push, not a reply. */
  enterPushMode(): void {
    this.#pushMode = true;
  }

  /** Sends a command and waits for its reply. */
  command(args: readonly string[]): Promise<RespValue> {
    if (this.#closed) {
      return Promise.reject(new Error('Redis connection is closed'));
    }
    return new Promise<RespValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Redis did not answer ${args[0]} in time`));
        this.destroy();
      }, this.#timeoutMs);
      timer.unref();
      this.#waiting.push({ resolve, reject, timer });
      this.#socket.write(encodeCommand(args));
    });
  }

  /** Sends a command whose answer arrives as a push, or not at all. */
  send(args: readonly string[]): void {
    if (!this.#closed) {
      this.#socket.write(encodeCommand(args));
    }
  }

  destroy(): void {
    this.#socket.destroy();
  }

  #deliver(value: RespValue): void {
    if (this.#pushMode) {
      this.#onPush?.(value);
      return;
    }
    const waiting = this.#waiting.shift();
    if (waiting !== undefined) {
      clearTimeout(waiting.timer);
      waiting.resolve(value);
    }
  }
}

/**
 * Where an event goes between API instances (EXPD-023).
 *
 * App Service runs more than one instance of the API, and a phone's stream
 * is held open by whichever one it reached. A teacher pressing *pause* is
 * served by one instance; the thirty phones that need to hear it are spread
 * across all of them. A broker is how the first tells the rest.
 *
 * Two brokers:
 *
 *   - `InProcessBroker`, for one instance on its own: a test, `npm run
 *     dev:api`, or an environment with no Redis.
 *   - `RedisBroker` (`redis-broker.ts`), for everything EXPD-007 deploys:
 *     Redis pub/sub, which every instance subscribes to.
 *
 * A broker moves strings. It knows nothing about runs, teams or who may
 * hear what; that is the hub's (`hub.ts`).
 */

/** Called with every message published to a channel. */
export type BrokerListener = (message: string) => void;

/** Carries messages between every instance of the API. */
export interface RealtimeBroker {
  /**
   * Sends a message to everybody subscribed to the channel, on this instance
   * and every other one.
   */
  publish(channel: string, message: string): Promise<void>;
  /**
   * Starts hearing a channel.
   *
   * Resolves once the subscription is in place, so that a message published
   * after that is heard. Returns the function that stops it.
   *
   * `onGap` is called when messages may have been lost — the broker lost its
   * connection and has just got it back — so that whoever is listening can
   * be told to read again.
   */
  subscribe(
    channel: string,
    listener: BrokerListener,
    onGap?: () => void,
  ): Promise<() => Promise<void>>;
  /** Stops everything and lets go of every connection. */
  close(): Promise<void>;
}

/** A broker for one instance: a map from channel to listeners. */
export class InProcessBroker implements RealtimeBroker {
  readonly #listeners = new Map<string, Set<BrokerListener>>();

  async publish(channel: string, message: string): Promise<void> {
    for (const listener of [...(this.#listeners.get(channel) ?? [])]) {
      // Delivered on the next turn, as Redis would, so a publisher never runs
      // a subscriber's code inside its own call.
      queueMicrotask(() => listener(message));
    }
  }

  // Nothing is ever lost in one process, so `onGap` is never called.
  async subscribe(channel: string, listener: BrokerListener): Promise<() => Promise<void>> {
    let listeners = this.#listeners.get(channel);
    if (listeners === undefined) {
      listeners = new Set();
      this.#listeners.set(channel, listeners);
    }
    listeners.add(listener);

    return async () => {
      const current = this.#listeners.get(channel);
      current?.delete(listener);
      if (current?.size === 0) {
        this.#listeners.delete(channel);
      }
    };
  }

  async close(): Promise<void> {
    this.#listeners.clear();
  }

  /** How many channels somebody is listening to. For tests. */
  get channelCount(): number {
    return this.#listeners.size;
  }
}

/**
 * The realtime hub (EXPD-023).
 *
 * One per API instance. It does two jobs:
 *
 *   - **Sending.** A route that changed something hands the hub a list of
 *     notices — an audience and an event each — and the hub publishes them
 *     on the run's channel through the broker, to every instance at once.
 *   - **Delivering.** Every open stream on this instance is attached to the
 *     hub. When a notice comes back from the broker, the hub gives it to each
 *     stream whose viewer is in its audience, and to nobody else.
 *
 * The audience is decided here, on the server, once per stream. A phone is
 * never sent an event and trusted to ignore it.
 *
 * **One broker subscription per run per instance**, not per stream. The
 * first stream on a run subscribes; the last one to close unsubscribes.
 *
 * **Sending never fails a request.** A notice is published after the change
 * behind it was committed. If Redis is down the change still happened, the
 * teacher's button still worked, and the phones catch up on their next
 * `channel.ready`. So `publish` logs a failure and resolves.
 */

import { randomUUID } from 'node:crypto';
import type { RealtimeEvent, RealtimeEventBody } from '@explorer/shared-types';

import type { RealtimeBroker } from './broker.ts';

/** Who an event is for. Staff hear everything in their own run. */
export type Audience =
  /** Everybody watching the run. */
  | { readonly kind: 'everyone' }
  /** Teachers and facilitators only. */
  | { readonly kind: 'staff' }
  /** Staff, and the phones of one team's students. */
  | { readonly kind: 'team'; readonly teamId: string }
  /** Staff, and one student's phone. */
  | { readonly kind: 'participant'; readonly participantId: string };

/** One thing to tell the run: who hears it, and what it says. */
export interface Notice {
  readonly audience: Audience;
  readonly event: RealtimeEventBody;
}

/** Which run a notice is about. The organisation is part of the channel name. */
export interface RunTarget {
  readonly organisationId: string;
  readonly sessionId: string;
}

/** Who is on the other end of a stream. */
export type Viewer =
  | { readonly kind: 'staff' }
  | {
      readonly kind: 'device';
      readonly participantId: string;
      /** The team they are on now. Kept up to date by `participant.team-changed`. */
      teamId: string | null;
    };

/** One open stream, as the hub sees it. */
export interface StreamListener {
  readonly viewer: Viewer;
  /** Writes an event down the stream. */
  deliver(event: RealtimeEvent): void;
  /** Events may have been lost; tell the client to read again. */
  resync(): void;
  /** Closes the stream. */
  end(): void;
}

/** What goes over the broker. */
interface Envelope {
  readonly audience: Audience;
  readonly event: RealtimeEvent;
}

/** What the hub needs. */
export interface RealtimeHubOptions {
  readonly broker: RealtimeBroker;
  /** Where a failed publish is reported. Defaults to `console.error`. */
  readonly log?: (message: string, error?: unknown) => void;
  /** The clock. Tests pass their own. */
  readonly now?: () => Date;
}

/** The name of a run's channel. The organisation is in it so two schools never share one. */
export function channelOf(target: RunTarget): string {
  return `expd:realtime:${target.organisationId}:${target.sessionId}`;
}

/** Whether a viewer is in an audience. */
export function hears(viewer: Viewer, audience: Audience): boolean {
  if (viewer.kind === 'staff') {
    return true;
  }
  switch (audience.kind) {
    case 'everyone':
      return true;
    case 'staff':
      return false;
    case 'team':
      return viewer.teamId !== null && viewer.teamId === audience.teamId;
    case 'participant':
      return viewer.participantId === audience.participantId;
  }
}

/** The streams on this instance watching one run. */
interface LocalChannel {
  readonly listeners: Set<StreamListener>;
  readonly subscribed: Promise<() => Promise<void>>;
}

/** Sends a run's events, and delivers them to the streams on this instance. */
export class RealtimeHub {
  readonly #broker: RealtimeBroker;
  readonly #log: (message: string, error?: unknown) => void;
  readonly #now: () => Date;
  readonly #channels = new Map<string, LocalChannel>();

  constructor(options: RealtimeHubOptions) {
    this.#broker = options.broker;
    this.#log = options.log ?? ((message, error) => console.error(`[realtime] ${message}`, error ?? ''));
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Tells a run about a change. Never throws.
   *
   * Call it after the change is committed, never inside the transaction: a
   * phone told about a score that is then rolled back would draw one that
   * never existed. Resolves with the events that did go out.
   */
  async publish(target: RunTarget, notices: readonly Notice[]): Promise<RealtimeEvent[]> {
    const channel = channelOf(target);
    const sent: RealtimeEvent[] = [];
    for (const notice of notices) {
      const envelope: Envelope = {
        audience: notice.audience,
        event: this.stamp(target.sessionId, notice.event),
      };
      try {
        await this.#broker.publish(channel, JSON.stringify(envelope));
        sent.push(envelope.event);
      } catch (error) {
        this.#log(`could not publish ${notice.event.type} to run ${target.sessionId}`, error);
      }
    }
    return sent;
  }

  /** Gives an event its id, its run and its time. */
  stamp(sessionId: string, body: RealtimeEventBody): RealtimeEvent {
    return { ...body, id: randomUUID(), sessionId, sentAt: this.#now().toISOString() };
  }

  /**
   * Starts delivering a run's events to one stream.
   *
   * Resolves once the broker subscription is in place, so that nothing
   * published after that is missed. Returns the function that detaches it.
   */
  async attach(target: RunTarget, listener: StreamListener): Promise<() => Promise<void>> {
    const channel = channelOf(target);
    let local = this.#channels.get(channel);
    if (local === undefined) {
      const listeners = new Set<StreamListener>();
      const subscribed = this.#broker.subscribe(
        channel,
        (message) => this.#dispatch(channel, message),
        () => {
          for (const each of [...listeners]) {
            each.resync();
          }
        },
      );
      local = { listeners, subscribed };
      this.#channels.set(channel, local);
      subscribed.catch(() => {
        if (this.#channels.get(channel)?.subscribed === subscribed) {
          this.#channels.delete(channel);
        }
      });
    }
    local.listeners.add(listener);

    try {
      await local.subscribed;
    } catch (error) {
      local.listeners.delete(listener);
      throw error;
    }

    const attached = local;
    let detached = false;
    return async () => {
      if (detached) {
        return;
      }
      detached = true;
      attached.listeners.delete(listener);
      if (attached.listeners.size === 0 && this.#channels.get(channel) === attached) {
        this.#channels.delete(channel);
        const unsubscribe = await attached.subscribed.catch(() => undefined);
        await unsubscribe?.().catch((error: unknown) => {
          this.#log(`could not unsubscribe from run ${target.sessionId}`, error);
        });
      }
    };
  }

  /** How many streams on this instance are watching a run. For tests and health. */
  listenerCount(target: RunTarget): number {
    return this.#channels.get(channelOf(target))?.listeners.size ?? 0;
  }

  #dispatch(channel: string, message: string): void {
    const envelope = parseEnvelope(message);
    if (envelope === undefined) {
      this.#log(`ignored a message on ${channel} that is not an event`);
      return;
    }
    const { audience, event } = envelope;

    for (const listener of [...(this.#channels.get(channel)?.listeners ?? [])]) {
      const viewer = listener.viewer;
      if (!hears(viewer, audience)) {
        continue;
      }
      // A phone's team is what decides which team events it hears, so moving
      // a student moves their stream with them, from the next event on.
      if (
        viewer.kind === 'device' &&
        event.type === 'participant.team-changed' &&
        event.participantId === viewer.participantId
      ) {
        viewer.teamId = event.teamId;
      }
      listener.deliver(event);
      if (
        viewer.kind === 'device' &&
        event.type === 'participant.removed' &&
        event.participantId === viewer.participantId
      ) {
        listener.end();
      }
    }
  }
}

/** Reads an envelope off the broker, or undefined when it is not one. */
function parseEnvelope(message: string): Envelope | undefined {
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const { audience, event } = value as { audience?: unknown; event?: unknown };
  if (
    typeof audience !== 'object' ||
    audience === null ||
    typeof (audience as { kind?: unknown }).kind !== 'string' ||
    typeof event !== 'object' ||
    event === null ||
    typeof (event as { type?: unknown }).type !== 'string'
  ) {
    return undefined;
  }
  return value as Envelope;
}

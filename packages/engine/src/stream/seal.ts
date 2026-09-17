/**
 * Putting a line into the stream, and sealing it there (EXPD-014).
 *
 * The one place a line gets its number and its seal. Nothing anywhere else
 * sets either, which is the same trick `ledger.ts` plays with points: a rule
 * that everybody has to remember is a rule that gets forgotten, and a rule
 * with one door is a rule that holds.
 *
 * ```ts
 * let stream = openStream();
 *
 * const scored = applyScoreChange({ kind: 'mission', ... });
 * if (scored.applied) {
 *   stream = appendScoreEvents(stream, scored.events);
 * }
 *
 * stream = appendProgressionEvents(
 *   stream,
 *   progressionEventsBetween(before, after, now),
 * );
 * ```
 *
 * **The seal is taken over the number as well as the contents.** A line moved
 * from place 9 to place 4 seals differently even though not one character of
 * the event changed, so reordering a stream is as visible as editing one.
 *
 * **A stream is a value, and appending gives back a new one.** The engine
 * keeps no state between calls, here as everywhere else, so the same lines
 * seal the same way on any machine at any time. That is the whole basis for
 * handing somebody a stream and inviting them to check it themselves.
 */

import {
  GENESIS_HASH,
  streamHeadHash,
  type ProgressionEvent,
  type ProgressionStreamEvent,
  type ScoreEvent,
  type ScoreStreamEvent,
  type StreamEntry,
  type StreamEvent,
  type StreamHash,
} from '@explorer/shared-types';

import { canonicalJson, sha256Hex } from './hash.ts';

/**
 * Where a stream has got to: the last line's number and its seal.
 *
 * What a writer that does not hold the whole stream needs. The lines live in
 * two database tables and a run can be an afternoon long, so reading all of
 * them back to write one more would be the wrong shape; the two figures below
 * are all that sealing the next line takes, and `team` in migration 0004
 * keeps them beside `total_score` for exactly that.
 */
export interface StreamPosition {
  /** The number of the last line. Nought before the first one. */
  readonly sequence: number;
  /** The seal on it. `GENESIS_HASH` before the first one. */
  readonly hash: StreamHash;
}

/** Before the first line: nothing written, and the fixed opening seal. */
export const STREAM_BEGINNING: StreamPosition = {
  sequence: 0,
  hash: GENESIS_HASH,
};

/** A stream with nothing in it yet. */
export function openStream(): readonly StreamEntry[] {
  return [];
}

/** Where a stream in memory has got to. */
export function positionOf(entries: readonly StreamEntry[]): StreamPosition {
  const last = entries.at(-1);
  return last === undefined
    ? STREAM_BEGINNING
    : { sequence: last.sequence, hash: last.hash };
}

/**
 * Seals events onto the end of a stream, given only where it has got to.
 *
 * Returns the new lines alone rather than the whole stream, because the
 * caller does not have the whole stream — that is why it is calling this one.
 * `appendToStream` is this with the lines it already holds put back on the
 * front.
 */
export function sealFrom(
  from: StreamPosition,
  events: readonly StreamEvent[],
): readonly StreamEntry[] {
  const sealed: StreamEntry[] = [];
  let sequence = from.sequence;
  let previousHash = from.hash;

  for (const event of events) {
    sequence += 1;
    const entry = sealEntry(event, sequence, previousHash);
    sealed.push(entry);
    previousHash = entry.hash;
  }

  return sealed;
}

/** Wraps a score change so it can be added to a stream. */
export function scoreLine(event: ScoreEvent): ScoreStreamEvent {
  return { kind: 'score', event };
}

/** Wraps a progression change so it can be added to a stream. */
export function progressionLine(event: ProgressionEvent): ProgressionStreamEvent {
  return { kind: 'progression', event };
}

/**
 * The seal one line comes to.
 *
 * Over the number, the seal before it, which kind of event it is, and the
 * event itself — all four as one canonical JSON object, so that a reader
 * working the seal out again has no choices left to make. Anybody can run
 * this: it is SHA-256 over a string with its keys in sorted order.
 */
export function entryDigest(
  event: StreamEvent,
  sequence: number,
  previousHash: StreamHash,
): StreamHash {
  return sha256Hex(
    canonicalJson({
      sequence,
      previousHash,
      kind: event.kind,
      event: event.event,
    }),
  );
}

/**
 * One event, numbered and sealed.
 *
 * Exported because a caller rebuilding a stream out of database rows needs
 * the same line the engine would have written, to compare with the one stored.
 */
export function sealEntry(
  event: StreamEvent,
  sequence: number,
  previousHash: StreamHash,
): StreamEntry {
  const hash = entryDigest(event, sequence, previousHash);
  return event.kind === 'score'
    ? { kind: 'score', event: event.event, sequence, previousHash, hash }
    : { kind: 'progression', event: event.event, sequence, previousHash, hash };
}

/**
 * Adds events to the end of a stream, in the order they are given.
 *
 * The numbering carries on from whatever the stream already holds, and each
 * line seals the one before it — including the ones added in this same call,
 * so appending three at once and appending them one at a time give the same
 * stream.
 */
export function appendToStream(
  entries: readonly StreamEntry[],
  ...events: readonly StreamEvent[]
): readonly StreamEntry[] {
  return [...entries, ...sealFrom(positionOf(entries), events)];
}

/** Adds the events one score change produced, oldest first. */
export function appendScoreEvents(
  entries: readonly StreamEntry[],
  events: readonly ScoreEvent[],
): readonly StreamEntry[] {
  return appendToStream(entries, ...events.map(scoreLine));
}

/** Adds the events one progression change produced, oldest first. */
export function appendProgressionEvents(
  entries: readonly StreamEntry[],
  events: readonly ProgressionEvent[],
): readonly StreamEntry[] {
  return appendToStream(entries, ...events.map(progressionLine));
}

/**
 * Seals a whole run of events into a fresh stream.
 *
 * What the simulation harness (EXPD-015) and a test want: everything that
 * happened, in order, numbered from one and sealed from `GENESIS_HASH`.
 */
export function sealStream(
  events: readonly StreamEvent[],
): readonly StreamEntry[] {
  return appendToStream(openStream(), ...events);
}

/** The seal the next line will name, for a stream still being written. */
export function headHashOf(entries: readonly StreamEntry[]): StreamHash {
  return streamHeadHash(entries);
}

/**
 * One line of a team's event stream (EXPD-014).
 *
 * A `ScoreEvent` says what a team earned. A `ProgressionEvent` says what they
 * were allowed to do. Neither says when it happened relative to the other,
 * and neither says it was not added afterwards. This is the envelope that
 * says both: a place in a numbered order, and a seal over everything before
 * it.
 *
 * **One stream per team, and one number line through it.** The two kinds of
 * event share the numbering rather than each keeping their own, because a
 * final result is an argument about order as much as about arithmetic: a
 * bonus awarded for finishing a mission the team was never shown is a
 * different complaint from one awarded a second too late, and only one
 * numbering can tell them apart. `sequence` starts at 1 and never skips.
 *
 * **Each line seals the one before it.** `hash` is taken over the line's own
 * contents *and* `previousHash`, so a line cannot be changed, removed or
 * slipped in without every hash after it disagreeing. That is what a stream
 * has to offer before anybody can dispute a result with it: not "the database
 * says so" but "here is the record, check it yourself".
 *
 * The seal is not a signature. It proves nobody edited the stream *in place*,
 * which is what a wrong total looks like; it does not prove who wrote it, and
 * somebody able to rewrite every row from a given line onwards could reseal
 * the lot. Two things already stand in the way of that, and both are
 * elsewhere: the table takes an INSERT and nothing else (migration 0004), and
 * `audit_log` (EXPD-006) records who touched what.
 */

import type { IsoTimestamp } from '../expedition/common.ts';
import type { ProgressionEvent } from '../progression/event.ts';
import type { ScoreEvent } from '../scoring/event.ts';

/**
 * A seal over one line, as lower-case hexadecimal.
 *
 * SHA-256, so 64 characters. The engine is what works one out; this package
 * only says what one looks like, because the live score screen (EXPD-045) and
 * the results screen (EXPD-059) both read a stream and neither depends on the
 * engine.
 */
export type StreamHash = string;

/**
 * What the line before the first one sealed.
 *
 * Sixty-four noughts. A stream has to start somewhere, and starting from a
 * fixed value rather than from nothing means the first line is sealed by
 * exactly the same rule as every line after it — so a reader checking a
 * stream has one rule to apply rather than one rule and an exception.
 */
export const GENESIS_HASH: StreamHash = '0'.repeat(64);

/** Which of the two kinds of event a line carries. */
export type StreamEventKind = 'score' | 'progression';

/** Every kind, in the order they are listed above. */
export const STREAM_EVENT_KINDS = [
  'score',
  'progression',
] as const satisfies readonly StreamEventKind[];

/** A score change, on its way into a stream. */
export interface ScoreStreamEvent {
  readonly kind: 'score';
  readonly event: ScoreEvent;
}

/** A progression change, on its way into a stream. */
export interface ProgressionStreamEvent {
  readonly kind: 'progression';
  readonly event: ProgressionEvent;
}

/**
 * One thing that happened to a team, before it has a place in the order.
 *
 * What a caller hands to the engine. The number and the seal are not on it,
 * because neither is the caller's to decide: both come from the stream it is
 * being added to.
 */
export type StreamEvent = ScoreStreamEvent | ProgressionStreamEvent;

/** What every sealed line carries, whichever kind it is. */
interface StreamEntryBase {
  /** Where the line sits in this team's stream. The first one is 1. */
  readonly sequence: number;
  /** The seal on the line before it, or `GENESIS_HASH` for the first. */
  readonly previousHash: StreamHash;
  /** The seal on this line, over its contents and `previousHash`. */
  readonly hash: StreamHash;
}

/** A sealed score change. */
export interface ScoreStreamEntry extends StreamEntryBase, ScoreStreamEvent {}

/** A sealed progression change. */
export interface ProgressionStreamEntry
  extends StreamEntryBase,
    ProgressionStreamEvent {}

/** One sealed line of a team's stream. */
export type StreamEntry = ScoreStreamEntry | ProgressionStreamEntry;

/** Says whether a line carries a score change. */
export function isScoreEntry(entry: StreamEntry): entry is ScoreStreamEntry {
  return entry.kind === 'score';
}

/** Says whether a line carries a progression change. */
export function isProgressionEntry(
  entry: StreamEntry,
): entry is ProgressionStreamEntry {
  return entry.kind === 'progression';
}

/**
 * When the line says it happened.
 *
 * Both kinds of event carry an `at`, so a reader can order a stream by time
 * without unwrapping it first. `sequence` is still what says which came
 * first: two lines can share a timestamp, and a clock that steps backwards
 * must not be able to reorder a record.
 */
export function streamEventAt(entry: StreamEvent): IsoTimestamp {
  return entry.event.at;
}

/** The seal on the last line, or `GENESIS_HASH` when the stream is empty. */
export function streamHeadHash(
  entries: readonly StreamEntry[],
): StreamHash {
  return entries.at(-1)?.hash ?? GENESIS_HASH;
}

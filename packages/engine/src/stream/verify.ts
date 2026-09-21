/**
 * Checking a stream, and saying where it went wrong (EXPD-014).
 *
 * The half of the ticket that makes a result disputable. Anything can produce
 * a total; what a record is for is letting somebody who does not believe the
 * total work it out again, and be told exactly which line they should be
 * arguing about if it comes out different.
 *
 * ```ts
 * const check = verifyStream(entries, { expectedTotal: team.totalScore });
 * if (!check.intact) {
 *   // Each defect names the line and what it should have been.
 *   return reply.status(409).send({ defects: check.defects });
 * }
 * ```
 *
 * **It reports everything, and it never throws.** A stream that does not add
 * up is a finding rather than a failure: the finding is the answer the ticket
 * asks for, and a check that stopped at the first defect would keep the rest
 * of the answer to itself.
 *
 * **An edited line is reported once, not as an avalanche.** The chain is
 * followed by the hash each line actually carries rather than by the hash its
 * contents come to, so changing line 9 marks line 9 as `edited` and leaves
 * lines 10 onwards alone. Removing or inserting a line is the other way
 * round: the line after the hole is `broken-chain`, because the hole has no
 * line of its own to mark.
 *
 * **A page of a stream can be checked on its own.** `startingFrom` says which
 * line and which seal the page follows, so a reader paging through a long run
 * does not have to hold the whole thing in memory to check any of it.
 */

import {
  isScoreEntry,
  type StreamDefect,
  type StreamEntry,
  type StreamVerification,
} from '@explorer/shared-types';

import { entryDigest, STREAM_BEGINNING, type StreamPosition } from './seal.ts';

/** What to hold a stream to, beyond its own seals. */
export interface VerifyStreamOptions {
  /**
   * The total somebody is claiming.
   *
   * A `team.total_score` column, a figure on a results screen, the number a
   * class was read out. When it is not the sum of the score lines, the stream
   * is right and the claim is wrong, and the check says so as a defect rather
   * than by correcting it quietly.
   */
  readonly expectedTotal?: number;
  /** The line and seal this page follows. The start of the stream by default. */
  readonly startingFrom?: StreamPosition;
}

/**
 * Checks that a stream is what was written, in the order it was written.
 *
 * Three things are checked of every line — that it is the number that follows
 * the one before it, that it names the seal on the one before it, and that
 * its own seal matches its own contents — and one of the stream as a whole,
 * when a total was given to hold it to.
 */
export function verifyStream(
  entries: readonly StreamEntry[],
  options: VerifyStreamOptions = {},
): StreamVerification {
  const defects: StreamDefect[] = [];
  const from = options.startingFrom ?? STREAM_BEGINNING;

  let expectedSequence = from.sequence + 1;
  let previousHash = from.hash;
  let total = 0;

  for (const entry of entries) {
    if (entry.sequence !== expectedSequence) {
      defects.push({
        code: 'out-of-order',
        sequence: entry.sequence,
        message:
          `Line ${entry.sequence} is where line ${expectedSequence} should be. ` +
          'A stream is numbered from one and never skips, so a gap means a ' +
          'line was taken out and a repeat means two were written for one place.',
        expected: String(expectedSequence),
        found: String(entry.sequence),
      });
    }

    if (entry.previousHash !== previousHash) {
      defects.push({
        code: 'broken-chain',
        sequence: entry.sequence,
        message:
          `Line ${entry.sequence} names a different line before it than the one ` +
          'it follows. Something was taken out of the stream or slipped into it.',
        expected: previousHash,
        found: entry.previousHash,
      });
    }

    const sealed = entryDigest(entry, entry.sequence, entry.previousHash);
    if (sealed !== entry.hash) {
      defects.push({
        code: 'edited',
        sequence: entry.sequence,
        message:
          `Line ${entry.sequence} does not match its own seal, so something in ` +
          'it was changed after it was written.',
        expected: sealed,
        found: entry.hash,
      });
    }

    if (isScoreEntry(entry)) {
      total += entry.event.points;
    }

    // The chain is followed by the seal the line carries rather than by the
    // one its contents come to, so one edited line is one defect rather than
    // the start of an avalanche down the rest of the stream.
    previousHash = entry.hash;
    expectedSequence = entry.sequence + 1;
  }

  const lastSequence = entries.at(-1)?.sequence ?? from.sequence;

  if (options.expectedTotal !== undefined && options.expectedTotal !== total) {
    defects.push({
      code: 'total-disagrees',
      sequence: lastSequence,
      message:
        `The stream adds up to ${total}, and the total being claimed is ` +
        `${options.expectedTotal}. Every line records what actually moved the ` +
        'total, so the stream is the record and the claim is the copy.',
      expected: String(total),
      found: String(options.expectedTotal),
    });
  }

  return {
    intact: defects.length === 0,
    defects,
    checked: entries.length,
    total,
    headHash: entries.at(-1)?.hash ?? from.hash,
  };
}

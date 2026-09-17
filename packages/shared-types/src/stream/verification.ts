/**
 * What came of checking a stream (EXPD-014).
 *
 * The point of keeping the record is that somebody can disagree with a result
 * and be answered with something better than "the database says so". Checking
 * a stream is what turns the record into that answer, and it has to be able
 * to come back with *where* rather than only with yes or no: "line 14 says
 * the team was awarded 25 for a speed bonus, and the seal on line 15 was
 * taken over a different line 14" is an answer somebody can act on, and
 * "the stream is invalid" is not.
 *
 * So a check reports every defect it finds, each naming the line, rather than
 * stopping at the first. A defect is never a refusal and never an exception:
 * a stream that does not add up is a finding, and the finding is the thing
 * the ticket asks to be able to produce.
 */

import type { StreamHash } from './entry.ts';

/** What is wrong with one line. */
export type StreamDefectCode =
  /**
   * The line is not the number that follows the one before it.
   *
   * A gap means a line was removed, and a repeat means two were written for
   * the same place. Either way the order is no longer one anybody can read.
   */
  | 'out-of-order'
  /**
   * The line's `previousHash` is not the seal on the line before it.
   *
   * The lines either side of a removed or inserted line, seen from the later
   * of the two.
   */
  | 'broken-chain'
  /**
   * The line's own seal does not match its contents.
   *
   * Something in the line was changed after it was written: the points, the
   * reason, the time, the mission it names.
   */
  | 'edited'
  /**
   * The total claimed is not the sum of the score lines.
   *
   * Found only when a check was given a total to hold the stream to — a
   * `team.total_score` column, a figure on a results screen, a number a
   * parent was told. The stream is always right and the total is always the
   * copy, because every event records what actually moved.
   */
  | 'total-disagrees';

/** Every defect code, in the order they are listed above. */
export const STREAM_DEFECT_CODES = [
  'out-of-order',
  'broken-chain',
  'edited',
  'total-disagrees',
] as const satisfies readonly StreamDefectCode[];

/** Says whether a string is one of the codes above. */
export function isStreamDefectCode(value: unknown): value is StreamDefectCode {
  return (
    typeof value === 'string' &&
    (STREAM_DEFECT_CODES as readonly string[]).includes(value)
  );
}

/** One thing wrong with a stream. */
export interface StreamDefect {
  readonly code: StreamDefectCode;
  /**
   * The line it is about.
   *
   * The line's own `sequence` for the three that are about a line. For
   * `total-disagrees` it is the last line checked, because the disagreement
   * is about the stream as a whole.
   */
  readonly sequence: number;
  /** A sentence a person can read. */
  readonly message: string;
  /** What the check worked out. A hash, or a number written as one. */
  readonly expected?: string;
  /** What the stream actually said. */
  readonly found?: string;
}

/** What checking a stream came to. */
export interface StreamVerification {
  /** Whether the stream is exactly what was written, in the order it was. */
  readonly intact: boolean;
  /** Everything wrong with it, oldest line first. Empty when it is intact. */
  readonly defects: readonly StreamDefect[];
  /** How many lines were checked. */
  readonly checked: number;
  /**
   * The sum of the score lines.
   *
   * What the team's total is, worked out from the record rather than read off
   * a column. Nought on a stream with no score lines in it.
   */
  readonly total: number;
  /** The seal on the last line, which is the whole stream in 64 characters. */
  readonly headHash: StreamHash;
}

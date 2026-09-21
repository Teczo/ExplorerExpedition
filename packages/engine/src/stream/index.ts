/**
 * The auditable event stream (EXPD-014).
 *
 * A team's score changes (EXPD-012) and the doors that opened for them
 * (EXPD-013), carried as one numbered, sealed record — so that any final
 * result can be rebuilt from the record by anybody, and argued with line by
 * line rather than taken on trust.
 *
 * Where to look:
 *
 *   `hash.ts`     The seal, and the exact bytes it is taken over.
 *   `seal.ts`     The one place a line gets its number and its seal.
 *   `events.ts`   What changed between two progression snapshots.
 *   `verify.ts`   Checking a stream, and saying which line is wrong.
 *   `replay.ts`   What a stream comes to, read from the stream alone.
 *
 * The words a stream is said in — the line, the defect, the result — are in
 * `@explorer/shared-types`, the same split every engine folder before it
 * makes, because the results screen (EXPD-059) shows a team what they ended
 * on and does not depend on the engine.
 */

export * from './hash.ts';
export * from './seal.ts';
export * from './events.ts';
export * from './verify.ts';
export * from './replay.ts';

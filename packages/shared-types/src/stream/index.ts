/**
 * The event stream vocabulary (EXPD-014).
 *
 * A team's score events (EXPD-012) and progression events say what happened
 * to them. This folder is what carries both as one ordered, sealed record, so
 * that a final result can be rebuilt from it by anybody and argued with by
 * anybody.
 *
 * Everything here is data. Working out a seal, adding a line, checking a
 * stream and rebuilding a result are the engine's, in `@explorer/engine`,
 * because all four are rules about the record rather than the record itself.
 *
 * The split is the one the registry (EXPD-009), the state machine (EXPD-010),
 * the completion interface (EXPD-011), the scoring engine (EXPD-012) and the
 * progression engine (EXPD-013) all make, and for the same reason: the
 * results screen (EXPD-059) shows a team what they ended on and where it came
 * from, and `apps/student-mobile` depends on this package alone.
 *
 * Where to look:
 *
 *   `entry.ts`         One line: the event, its place in the order, its seal.
 *   `verification.ts`  What came of checking a stream, and where it went wrong.
 *   `result.ts`        What a stream comes to, rebuilt from the stream alone.
 */

export * from './entry.ts';
export * from './verification.ts';
export * from './result.ts';

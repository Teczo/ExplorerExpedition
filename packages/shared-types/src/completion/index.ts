/**
 * The completion and validation vocabulary (EXPD-011).
 *
 * One mission is completed in one of six ways: a scanned code matched, a
 * photo was handed in, a teacher approved the work, an answer was right, a
 * place was reached, or a clock ran out. This folder holds the words all six
 * are said in, so that nothing downstream has six shapes to read.
 *
 * Everything here is data. The interface that produces it — the one that
 * calls a mission type's behaviour, checks a place, weighs a teacher's
 * decision and hands the state machine a trigger — is in `@explorer/engine`,
 * because those are game rules.
 *
 * The split is the one the mission type registry (EXPD-009) and the mission
 * state machine (EXPD-010) both make, and for the same reason: the student
 * app shows a verdict on the screen a team is looking at while they wait, and
 * it depends on this package alone.
 *
 * Where to look:
 *
 *   `outcome.ts`   What was concluded, what concluded it, who still has to look.
 *   `verdict.ts`   All of that together, as one answer.
 *   `refusal.ts`   Work that was not checked at all, and why.
 *   `position.ts`  Where a device says it is.
 */

export * from './outcome.ts';
export * from './verdict.ts';
export * from './refusal.ts';
export * from './position.ts';

/**
 * The completion and validation interface (EXPD-011).
 *
 * One door for every way a mission is finished: a scanned code that matched,
 * a photo handed in, a teacher's approval, a right answer, a place reached, a
 * clock run out. All six arrive as one of three checks — a submission, a
 * decision, an expiry — and all six leave as one verdict and one walk of the
 * state machine's table.
 *
 * Where to look:
 *
 *   `policy.ts`    What the two documents say about checking one mission.
 *   `location.ts`  Was the team in the right place.
 *   `timer.ts`     Had the mission's own clock run out.
 *   `complete.ts`  The interface itself.
 *
 * The words a verdict is said in — the outcomes, the methods, what still
 * needs a person — are in `@explorer/shared-types`, the same split the
 * registry (EXPD-009) and the state machine (EXPD-010) make, because the
 * student app shows a verdict and does not depend on the engine.
 */

export * from './policy.ts';
export * from './location.ts';
export * from './timer.ts';
export * from './complete.ts';

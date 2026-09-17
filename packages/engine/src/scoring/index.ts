/**
 * The scoring engine (EXPD-012).
 *
 * What a verdict is worth. Base points, the bonuses that add to them, the
 * penalties that take them away, and one line written down for every change
 * either makes.
 *
 * Where to look:
 *
 *   `policy.ts`  What the two documents say about what a mission is worth.
 *   `ledger.ts`  The one place points are minted, capped and floored.
 *   `score.ts`   The engine itself.
 *
 * The words a score is said in — the ten reasons, the event, the record — are
 * in `@explorer/shared-types`, the same split the registry (EXPD-009), the
 * state machine (EXPD-010) and the completion interface (EXPD-011) make,
 * because the live score screen (EXPD-045) shows a total on a phone and does
 * not depend on the engine.
 */

export * from './policy.ts';
export * from './ledger.ts';
export * from './score.ts';

/**
 * The scoring vocabulary (EXPD-012).
 *
 * What a team's score is, every reason it can move, the line written down
 * each time it does, and the changes the rules will not make. This folder
 * holds the words; working out what a verdict is worth is the scoring engine
 * in `@explorer/engine`, because that is a game rule.
 *
 * The split is the one the registry (EXPD-009), the state machine (EXPD-010)
 * and the completion interface (EXPD-011) all make, and for the same reason:
 * the live score screen (EXPD-045) shows a total and the reasons behind it on
 * a phone, and `apps/student-mobile` depends on this package alone.
 *
 * Where to look:
 *
 *   `reason.ts`   The ten reasons a score moves.
 *   `event.ts`    One change to a score, and what trimmed it.
 *   `total.ts`    The total, the running counts, and the whole stream.
 *   `refusal.ts`  A change the rules would not make.
 */

export * from './reason.ts';
export * from './event.ts';
export * from './total.ts';
export * from './refusal.ts';

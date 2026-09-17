/**
 * The mission state machine (EXPD-010).
 *
 * Where one team stands on one mission, and every way that can change. Eight
 * states, eleven triggers, and one rule running through all of them: a
 * mission state only ever changes by a named trigger walking the table in
 * `table.ts`, and every change that is made is written down.
 *
 * Where to look:
 *
 *   `table.ts`    Every edge in the machine, as data.
 *   `policy.ts`   The two settings that bend it: max attempts, and skipping.
 *   `machine.ts`  Applying a trigger, asking what is possible, replaying.
 *   `errors.ts`   The one thing that throws, and when.
 *
 * The words themselves — the states, the triggers, the shape of a logged line
 * — are in `@explorer/shared-types`, because the student app draws a mission
 * state on every screen and does not depend on the engine.
 */

export * from './table.ts';
export * from './policy.ts';
export * from './errors.ts';
export * from './machine.ts';

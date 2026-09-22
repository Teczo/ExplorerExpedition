/**
 * The lifecycle of one run (EXPD-019).
 *
 * A run of an expedition is one lesson: one class, one afternoon, one code on
 * the whiteboard. EXPD-018 gave it the code and filled it with students. This
 * is the run itself — making it, starting it, stopping the clock, starting it
 * again, giving the class more time, and stopping it for good — and the
 * runtime state every team in it plays against.
 *
 * Where to look:
 *
 *   `timing-rules.ts`        The clock the pinned revision lays down.
 *   `session-clock.ts`       How long a run has been going, and how long is
 *                            left. Worked out on every read, never stored.
 *   `session-repository.ts`  The run's table, through the tenant repository.
 *   `session-service.ts`     The rules: which state may follow which, and
 *                            what pausing does to the clock.
 *   `views.ts`               What a client reads.
 *   `routes.ts`              The endpoints, and the stack in front of them.
 *
 * The order the states come in is not here. It is
 * `@explorer/shared-types/participation/lifecycle.ts`, because Director Mode
 * and the student app read the same table this does, and three copies of it
 * would be three tables that drift.
 *
 * What is deliberately not here. A team's own lifecycle is EXPD-041: starting
 * a run does not move a team from `forming` to `playing`, and ending one does
 * not mark anybody `finished`. Nothing ends a run whose time is up — the
 * clock reports `expired` and a person, or a live trigger (EXPD-057), acts on
 * it. The dashboard that presses these buttons is EXPD-055 and EXPD-058, and
 * telling thirty phones that a run has been paused is EXPD-023 and EXPD-047.
 */

export * from './timing-rules.ts';
export * from './session-clock.ts';
export * from './session-repository.ts';
export * from './session-service.ts';
export * from './views.ts';
export * from './routes.ts';

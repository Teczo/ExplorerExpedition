/**
 * The simulation harness (EXPD-015).
 *
 * A headless runner that plays a whole expedition with fake teams and says
 * what happened. It is the first thing in this package that *uses* the engine
 * rather than being part of it: it owns a clock and a random number, and it
 * drives the five folders above it through their own front doors.
 *
 * Three callers want it, and they want three different halves of the same
 * answer:
 *
 *   - **Tests.** A run exercises the state machine (EXPD-010), the completion
 *     interface (EXPD-011), the scoring engine (EXPD-012), progression
 *     (EXPD-013) and the event stream (EXPD-014) against each other, over
 *     thousands of attempts, in the order a real afternoon would put them in.
 *     What comes back includes each team's sealed stream, so a test can
 *     verify and replay a run the engine just played.
 *   - **Duration estimates.** An author wants to know whether their
 *     expedition fits in a double period. `report.duration` is the answer,
 *     over as many teams as they care to run.
 *   - **The AI builder's validation step (EXPD-066).** A generated document
 *     is valid long before it is playable. `report.findings` is the list of
 *     things that would go wrong on the day — a mission nothing opens the way
 *     to, an expedition nobody can finish, a timer nobody can beat.
 *
 * ```ts
 * const report = simulateExpedition({ definition, teamCount: 5, seed: 'the-lake' });
 *
 * if (!report.playable) {
 *   return report.findings.filter((finding) => finding.severity === 'error');
 * }
 * report.duration.medianSeconds;
 * ```
 *
 * Where to look:
 *
 *   `random.ts`   The one thing allowed to vary, and its seed.
 *   `clock.ts`    The clock the engine does not have.
 *   `teams.ts`    The fake teams, as dials.
 *   `players.ts`  What a fake team hands in.
 *   `scripted.ts` Playing types that have no code behind them.
 *   `plan.ts`     What a run is told, read once.
 *   `run.ts`      The runner.
 *   `findings.ts` Reading a run back as advice.
 *   `report.ts`   What comes back.
 *
 * **Two promises hold the whole thing up.** The same seed and the same
 * document give the same run, down to the last timestamp, because nothing in
 * it reads `Date.now()` or `Math.random`. And every game rule a run applies
 * comes out of the engine's own functions, so a run cannot pass where the
 * platform would fail.
 */

export * from './random.ts';
export * from './clock.ts';
export * from './teams.ts';
export * from './players.ts';
export * from './scripted.ts';
export * from './report.ts';
export * from './plan.ts';
export * from './findings.ts';
export * from './run.ts';

/**
 * Progression and unlock evaluation (EXPD-013).
 *
 * What the expedition comes to for one team. Which stops they have reached,
 * which missions the lock is off, which ones they are shown at all, and what
 * is holding the rest up — worked out from the graph, the team's records and
 * nothing else.
 *
 * Where to look:
 *
 *   `policy.ts`        What the definition says about how a team moves.
 *   `situation.ts`     What the engine is told about one team.
 *   `conditions.ts`    Whether one unlock condition holds.
 *   `routes.ts`        Which teams an edge is for.
 *   `dependencies.ts`  What stands in front of a mission, with no team in it.
 *   `evaluate.ts`      The engine itself.
 *
 * The words a snapshot is said in — the stops, the missions, the reasons one
 * is blocked — are in `@explorer/shared-types`, the same split the registry
 * (EXPD-009), the state machine (EXPD-010), the completion interface
 * (EXPD-011) and the scoring engine (EXPD-012) make, because the mission
 * board (EXPD-042) draws a locked mission on a phone and does not depend on
 * the engine.
 */

export * from './policy.ts';
export * from './situation.ts';
export * from './conditions.ts';
export * from './routes.ts';
export * from './dependencies.ts';
export * from './evaluate.ts';

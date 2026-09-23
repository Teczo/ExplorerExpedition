/**
 * Leaderboards (EXPD-022).
 *
 * Where to look:
 *
 *   `ranking.ts`                 Placing teams: the total, then the tie breaks.
 *   `leaderboard-repository.ts`  The figures, read column by column.
 *   `leaderboard-service.ts`     Who may see which board, and when.
 *   `views.ts`                   What a client reads. Display names only.
 *   `routes.ts`                  The endpoints, and the stack in front of them.
 *
 * What is deliberately not here. Pushing a new board to the phones when a
 * score changes is the realtime channel (EXPD-023). Drawing it is the student
 * app (EXPD-045) and Director Mode (EXPD-055). Results and analytics after the
 * afternoon are EXPD-059.
 */

export * from './ranking.ts';
export * from './leaderboard-repository.ts';
export * from './leaderboard-service.ts';
export * from './views.ts';
export * from './routes.ts';

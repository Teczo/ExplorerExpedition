/**
 * The audit log (EXPD-006).
 *
 * The shared half: what an entry says, and the closed list of things it can
 * say happened. The Studio, the creator web app and the admin portal all read
 * entries, so the vocabulary lives here rather than inside the API.
 *
 * Nothing here writes a row. That is `apps/api/src/audit`, which also decides
 * what may be recorded and what has to be left out.
 *
 * Where to look:
 *
 *   `actions.ts`  What an entry can say happened, and what it is about.
 *   `entry.ts`    Who did it, what changed, and the shape a reader gets.
 */

export * from './actions.ts';
export * from './entry.ts';

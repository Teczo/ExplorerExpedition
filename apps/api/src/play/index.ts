/**
 * Playing a mission (EXPD-020).
 *
 * A team starts a try, hands work in, opens a hint; a teacher marks waiting
 * work complete or sends it back. The Mission Engine decides every outcome —
 * this is the part that reads the rows it needs, asks it, and writes down
 * what it said.
 *
 * Where to look:
 *
 *   `mission-log.ts`        A mission's history, stored line for line and
 *                           replayed into a state on every read.
 *   `mission-types.ts`      The registry one submission is judged against.
 *   `play-repository.ts`    The tables, through the tenant repository.
 *   `play-service.ts`       The four actions, and the transactions they run in.
 *   `views.ts`              What a client reads back.
 *   `routes.ts`             The endpoints, and the stack in front of them.
 */

export * from './mission-log.ts';
export * from './mission-types.ts';
export * from './play-repository.ts';
export * from './play-service.ts';
export * from './views.ts';
export * from './routes.ts';

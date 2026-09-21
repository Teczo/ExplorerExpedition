/**
 * Carrying a team's event stream across the system (EXPD-014).
 *
 * The engine seals a line, checks a stream and rebuilds a result. This is
 * what stores the lines and reads them back, so that all three hold of rows
 * in a database and not only of values in memory.
 *
 * Where to look:
 *
 *   `rows.ts`         A line as columns, and the columns back as the same line.
 *   `team-stream.ts`  One team's stream: appending to it, and reading it back.
 */

export * from './rows.ts';
export * from './team-stream.ts';

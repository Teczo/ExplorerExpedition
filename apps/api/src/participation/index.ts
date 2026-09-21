/**
 * Join codes, teams and the students in a run (EXPD-018).
 *
 * A run of an expedition is a lesson: one class, one afternoon, one code on
 * the whiteboard. This is everything between that code and a team sheet.
 *
 * Where to look:
 *
 *   `join-codes.ts`              Making a code a child can read and type.
 *   `join-code-directory.ts`     Turning one back into a run. The one read
 *                                here that is not scoped to an organisation,
 *                                and the file explains why at length.
 *   `team-rules.ts`              The limits, read out of the pinned revision.
 *   `participation-repository.ts` The four tables, through the tenant repository.
 *   `participation-service.ts`   The rules: one team at a time, and the
 *                                limits the document lays down.
 *   `views.ts`                   What a client reads.
 *   `routes.ts`                  The endpoints, and the stack in front of them.
 *
 * What is deliberately not here. Making a run, starting it, pausing it and
 * ending it are EXPD-019: this ticket gives a run its code and fills it with
 * students, and says nothing about which state may follow which. A student
 * forming their own team from inside the app is EXPD-041. What an
 * organisation has paid for is EXPD-069 — the only limits enforced here are
 * the ones the expedition's own document lays down.
 */

export * from './join-codes.ts';
export * from './join-code-directory.ts';
export * from './team-rules.ts';
export * from './participation-repository.ts';
export * from './participation-service.ts';
export * from './views.ts';
export * from './routes.ts';

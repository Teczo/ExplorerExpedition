/**
 * Expeditions: creating them, reading them, and freezing a revision
 * (EXPD-017).
 *
 * An expedition is not one thing that gets edited. It is a row that keeps its
 * id forever and a stack of revisions, and everything worth reading lives in
 * a revision. That split is what makes publishing mean something: a published
 * revision is frozen, and a class playing it goes on playing exactly what
 * their teacher published, however much the author changes afterwards.
 *
 * Where to look:
 *
 *   `documents.ts`             What the platform writes into a document,
 *                              whatever the client sent.
 *   `expedition-repository.ts` The two tables, through the tenant repository.
 *   `projection.ts`            The flat copy other rows point at.
 *   `expedition-service.ts`    The rules: one draft, and publishing freezes it.
 *   `views.ts`                 What a client reads.
 *   `routes.ts`                The endpoints, and the stack in front of them.
 *
 * The document in `expedition_version.definition` is the source of truth
 * (EXPD-002, and migration 0001 says so). Everything else — the title on the
 * row, the missions in `mission_instance`, the stops in `mission_node` — is a
 * copy written from it, so a disagreement between the two is always the
 * copy's fault and the copy is always the thing to fix.
 */

export * from './documents.ts';
export * from './expedition-repository.ts';
export * from './projection.ts';
export * from './expedition-service.ts';
export * from './views.ts';
export * from './routes.ts';

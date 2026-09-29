/**
 * Mission types, as the Studio's builder saves, publishes and versions them
 * (EXPD-025, EXPD-031).
 *
 * Where to look:
 *
 *   `documents.ts`             Checking a type the Studio sent.
 *   `mission-type-service.ts`  The rules: one key and version, drafts change,
 *                              publishing freezes, a change is a new version.
 *   `views.ts`                 What the Studio reads.
 *   `routes.ts`                The endpoints, and the stack in front of them.
 *   `platform/`                The types the platform ships as code, such as
 *                              the QR hunt (EXPD-032).
 */

export * from './documents.ts';
export * from './mission-type-service.ts';
export * from './views.ts';
export * from './routes.ts';
export * from './platform/index.ts';

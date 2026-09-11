/**
 * The Expedition Definition schema (EXPD-002).
 *
 * This folder is the contract. Every client, the Mission Engine and the AI
 * builder read and write the shape described here.
 *
 * Where to look:
 *
 *   `version.ts`     How the schema is versioned, and what a reader accepts.
 *   `common.ts`      Ids, times, places and other small pieces.
 *   `metadata.ts`    The descriptive part. No effect on play.
 *   `mission.ts`     One mission placed inside one expedition.
 *   `graph.ts`       The stops, the links between them, and unlock conditions.
 *   `rules.ts`       How the expedition is played.
 *   `scoring.ts`     How points are earned and lost.
 *   `definition.ts`  The whole document.
 *   `validate.ts`    Checking that an unknown value really is one.
 */

export * from './version.ts';
export * from './common.ts';
export * from './metadata.ts';
export * from './mission.ts';
export * from './graph.ts';
export * from './rules.ts';
export * from './scoring.ts';
export * from './definition.ts';
export * from './validate.ts';

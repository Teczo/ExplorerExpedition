/**
 * The mission type vocabulary (EXPD-009).
 *
 * A mission type says what kind of task a mission is, what settings it takes,
 * and what a submission for it looks like. This folder holds everything about
 * one that is *data*: the words, the schema language and the checks. It has
 * no behaviour in it and no state, so the Studio, the API, the AI builder and
 * the student app can all read a mission type without pulling in the engine.
 *
 * The registry that holds types and joins them to their runtime behaviour is
 * `@explorer/engine`, because behaviour is engine work.
 *
 * Where to look:
 *
 *   `capabilities.ts`     What a type needs from the student's device.
 *   `issues.ts`           What a failed check says.
 *   `config-schema.ts`    The schema language, and checking a schema.
 *   `validate-config.ts`  Checking a value against a schema.
 *   `definition.ts`       What one mission type is, and checking one.
 */

export * from './capabilities.ts';
export * from './issues.ts';
export * from './config-schema.ts';
export * from './validate-config.ts';
export * from './definition.ts';

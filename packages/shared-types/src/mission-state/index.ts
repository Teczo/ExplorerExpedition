/**
 * The mission state vocabulary (EXPD-010).
 *
 * A mission instance (EXPD-002) is one task in one expedition. This folder
 * holds the words for where one team stands on one of them: the eight states,
 * the eleven things that move a mission between them, the line written down
 * every time one does, and the record that carries all three.
 *
 * Everything here is data. The rules — which trigger may follow which state,
 * what a team's attempt policy does to them, and how a history is replayed —
 * are the state machine in `@explorer/engine`, because those are game rules
 * and the engine is where the game is decided.
 *
 * The split is the same one the mission type registry (EXPD-009) makes, and
 * for the same reason: the student app reads a mission state on every screen
 * and depends on this package alone.
 *
 * Where to look:
 *
 *   `states.ts`      The eight states a mission can be in.
 *   `triggers.ts`    What moves it, and which side of the game moved it.
 *   `transition.ts`  One line of a mission's history, and a refused change.
 *   `progress.ts`    The state, the tries used and the whole history.
 */

export * from './states.ts';
export * from './triggers.ts';
export * from './transition.ts';
export * from './progress.ts';

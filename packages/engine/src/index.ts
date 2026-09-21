/**
 * Mission Engine.
 *
 * The engine holds the rules of the game. It has no database, no HTTP and no
 * framework code, so it can be unit tested and simulated on its own.
 *
 * The mission type registry (EXPD-009) is here, in `./mission-types`. It is
 * what lets a new kind of mission arrive as a registration rather than as a
 * change to the engine, so nothing else in this package knows what a QR hunt
 * is.
 *
 * The mission state machine (EXPD-010) is in `./mission-state`. It owns where
 * a team stands on a mission and every way that can change, so that no other
 * part of the platform writes a mission state of its own.
 *
 * The completion and validation interface (EXPD-011) is in `./completion`.
 * It is the one door everything that finishes a mission comes through, and
 * the only thing that calls a mission type's behaviour.
 *
 * The scoring engine (EXPD-012) is in `./scoring`. It turns a verdict into
 * points and writes down every change it makes, so a team's total is always
 * the sum of the reasons behind it.
 *
 * Progression and unlock evaluation (EXPD-013) is in `./progression`. It is
 * what the graph comes to for one team: where they have got to, which
 * missions the lock is off, and which ones they are shown at all.
 *
 * The auditable event stream (EXPD-014) is in `./stream`. It carries the
 * score changes and the progression changes as one numbered, sealed record,
 * so that a final result can be rebuilt from it and disputed line by line.
 *
 * The simulation harness (EXPD-015) is in `./simulation`. It is the first
 * thing here that uses the engine rather than being part of it: it plays a
 * whole expedition with fake teams, through the five doors above and no
 * others, so that a test, a duration estimate and the AI builder's validation
 * step all run the game the platform would have run.
 */

import { APP_NAMES } from '@explorer/shared-types';

export * from './mission-types/index.ts';
export * from './mission-state/index.ts';
export * from './completion/index.ts';
export * from './scoring/index.ts';
export * from './progression/index.ts';
export * from './stream/index.ts';
export * from './simulation/index.ts';

/** The version of the engine contract that callers are talking to. */
export const ENGINE_VERSION = '0.1.0';

/** Returns true when the given name is one of the platform apps. */
export function isKnownApp(name: string): boolean {
  return (APP_NAMES as readonly string[]).includes(name);
}

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
 * The rest arrives in later tickets:
 *   EXPD-010  mission state machine
 *   EXPD-011  completion and validation interface
 *   EXPD-012  scoring engine
 *   EXPD-013  progression and unlock evaluation
 *   EXPD-014  auditable score event stream
 *   EXPD-015  simulation harness
 */

import { APP_NAMES } from '@explorer/shared-types';

export * from './mission-types/index.ts';

/** The version of the engine contract that callers are talking to. */
export const ENGINE_VERSION = '0.1.0';

/** Returns true when the given name is one of the platform apps. */
export function isKnownApp(name: string): boolean {
  return (APP_NAMES as readonly string[]).includes(name);
}

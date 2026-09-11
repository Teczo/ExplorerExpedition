/**
 * Mission Engine.
 *
 * The engine holds the rules of the game. It has no database, no HTTP and no
 * framework code, so it can be unit tested and simulated on its own.
 *
 * The real behaviour arrives in later tickets:
 *   EXPD-009  mission type registry
 *   EXPD-010  mission state machine
 *   EXPD-011  completion and validation interface
 *   EXPD-012  scoring engine
 *   EXPD-013  progression and unlock evaluation
 *   EXPD-014  auditable score event stream
 *   EXPD-015  simulation harness
 *
 * This scaffold only proves the package builds and can be imported.
 */

import { APP_NAMES } from '@explorer/shared-types';

/** The version of the engine contract that callers are talking to. */
export const ENGINE_VERSION = '0.1.0';

/** Returns true when the given name is one of the platform apps. */
export function isKnownApp(name: string): boolean {
  return (APP_NAMES as readonly string[]).includes(name);
}

/**
 * The mission types the platform ships as code (EXPD-032 to EXPD-039).
 *
 * Each one is a `MissionTypeEntry` with a behaviour, so it can judge work on
 * its own, and each one also has a platform `mission_type` row written by a
 * migration, so the Studio lists it and an expedition can be checked against
 * it. A test holds the row and the code to the same definition.
 *
 * `createApp` plays with these unless it is handed a list of its own.
 */

import type { MissionTypeEntry } from '@explorer/engine';

import { photoEvidence } from './photo-evidence.ts';
import { physicalChallenge } from './physical-challenge.ts';
import { puzzle } from './puzzle.ts';
import { qrHunt } from './qr-hunt.ts';

export * from './photo-evidence.ts';
export * from './physical-challenge.ts';
export * from './puzzle.ts';
export * from './qr-hunt.ts';

/** Every mission type the platform ships as code. */
export const PLATFORM_MISSION_TYPES: readonly MissionTypeEntry[] = [
  qrHunt,
  photoEvidence,
  physicalChallenge,
  puzzle,
];

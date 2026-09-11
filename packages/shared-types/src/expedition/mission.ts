/**
 * A mission placed inside one expedition.
 *
 * A *mission type* is the kind of task: scan a QR code, take a photo, solve a
 * puzzle. Mission types live in the registry (EXPD-009) and are not part of
 * this document.
 *
 * A *mission instance* is one use of a mission type inside one expedition,
 * together with the settings the author chose. That is what this file
 * describes.
 */

import type {
  HintId,
  JsonObject,
  LocationConstraint,
  MediaRef,
  MissionInstanceId,
  Seconds,
} from './common.ts';
import type { MissionScoring } from './scoring.ts';

/** How a team's answer is judged. */
export type VerificationMode =
  /** The engine decides on its own, with no person involved. */
  | 'automatic'
  /** A teacher reviews the submission before it counts (EXPD-037, EXPD-056). */
  | 'teacher'
  /** The engine decides, and a teacher may overrule it afterwards. */
  | 'automatic-with-review';

/** How many times a team may try a mission. */
export interface AttemptPolicy {
  /**
   * The largest number of tries allowed.
   *
   * `null` means there is no limit. Zero is not allowed, because a mission no
   * team can attempt should be removed instead.
   */
  maxAttempts: number | null;
  /** How long a team must wait after a wrong answer before trying again. */
  cooldownSeconds?: Seconds;
}

/**
 * One hint a team may spend a token on.
 *
 * The definition holds the hint text and its cost. Handing hints out and
 * counting tokens is EXPD-046.
 */
export interface HintDefinition {
  id: HintId;
  /** The hint text shown to the team. */
  text: string;
  /**
   * The order hints are offered in, lowest first.
   *
   * Two hints on the same mission must not share an order.
   */
  order: number;
  /** How many hint tokens this hint costs. Zero means it is free. */
  tokenCost: number;
}

/** One mission placed inside one expedition. */
export interface MissionInstance {
  id: MissionInstanceId;
  /**
   * Which mission type this is, as a key into the registry (EXPD-009).
   *
   * Example: `qr-hunt`. This document does not say what the key means.
   */
  missionTypeId: string;
  /**
   * The version of the mission type the author configured against.
   *
   * It is pinned so that a later change to the mission type cannot silently
   * change a published expedition.
   */
  missionTypeVersion: string;
  /** The mission name shown to students. */
  title: string;
  /** The short task description shown on the mission board. */
  brief: string;
  /** The full instructions, shown once a team opens the mission. */
  instructions?: string;
  /**
   * The settings that belong to the mission type itself.
   *
   * This object is deliberately opaque here. A QR hunt stores its codes in it,
   * a puzzle stores its answers. Only the mission type knows the right shape,
   * so only the registry (EXPD-009) can check it. Validating this document
   * checks that the field is an object, and nothing more.
   */
  config: JsonObject;
  scoring: MissionScoring;
  attempts: AttemptPolicy;
  /**
   * How long a team has once it opens the mission.
   *
   * Left out when the mission is not timed.
   */
  timeLimitSeconds?: Seconds;
  verification: VerificationMode;
  /** Hints offered on this mission. May be empty. */
  hints: HintDefinition[];
  /** Images, audio or video shown with the mission. May be empty. */
  media: MediaRef[];
  /** Where a team has to be to attempt the mission, when that matters. */
  location?: LocationConstraint;
}

/** Every verification mode. */
export const VERIFICATION_MODES = [
  'automatic',
  'teacher',
  'automatic-with-review',
] as const;

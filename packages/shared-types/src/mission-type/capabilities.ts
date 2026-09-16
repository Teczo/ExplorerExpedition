/**
 * What a mission type needs from the student's device.
 *
 * `mission_type.capabilities` in migration 0001 stores this list and left it
 * to EXPD-009 to give it a meaning. This file is that meaning, and it is a
 * closed list on purpose: the student app has to be able to look at an
 * expedition before a team starts it and say "this one needs a camera", and
 * it can only do that if every mission type draws from the same words.
 */

/** One thing a mission type needs from the device it is played on. */
export type MissionCapability =
  /** Takes a photo or a video (EXPD-044). */
  | 'camera'
  /** Reads the device position (EXPD-039). */
  | 'location'
  /** Scans a QR code (EXPD-043). */
  | 'qr'
  /** Places or recognises augmented reality content (EXPD-072). */
  | 'ar'
  /** Records audio (EXPD-038). */
  | 'microphone';

/**
 * Every capability, in the order the migration lists them.
 *
 * Adding a word here is a change to the contract between the registry and
 * the student app, so it belongs to the ticket that makes the app able to
 * honour it — not to the ticket that adds a mission type wanting it.
 */
export const MISSION_CAPABILITIES = [
  'camera',
  'location',
  'qr',
  'ar',
  'microphone',
] as const satisfies readonly MissionCapability[];

/** Says whether a string is one of the capabilities above. */
export function isMissionCapability(value: unknown): value is MissionCapability {
  return (
    typeof value === 'string' &&
    (MISSION_CAPABILITIES as readonly string[]).includes(value)
  );
}

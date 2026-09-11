/**
 * Small building blocks used across the Expedition Definition.
 *
 * Nothing here is expedition specific on its own. These are the pieces the
 * larger parts of the schema are assembled from.
 */

import type { Id } from '../index.ts';

/** Any value that survives a round trip through JSON. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A JSON object. Used where the schema holds data it does not itself define. */
export type JsonObject = { [key: string]: JsonValue };

/** The id of one expedition. */
export type ExpeditionId = Id<'expedition'>;

/** The id of one node in the expedition graph. */
export type NodeId = Id<'node'>;

/** The id of one edge in the expedition graph. */
export type EdgeId = Id<'edge'>;

/** The id of one mission placed inside an expedition. */
export type MissionInstanceId = Id<'missionInstance'>;

/** The id of one scoring rule. */
export type ScoringRuleId = Id<'scoringRule'>;

/** The id of one hint. */
export type HintId = Id<'hint'>;

/** The id of a stored media file. */
export type MediaId = Id<'media'>;

/**
 * An instant in time, written as an ISO 8601 string in UTC.
 *
 * Example: `2026-09-11T14:03:00.000Z`. The schema never stores a local time,
 * because an expedition can be authored in one timezone and played in another.
 */
export type IsoTimestamp = string;

/**
 * A length of time in whole seconds.
 *
 * The schema uses seconds everywhere. It never mixes seconds and minutes in
 * the same document, so a reader never has to guess the unit from the name.
 */
export type Seconds = number;

/** A point on the earth. */
export interface GeoPoint {
  /** Degrees north of the equator, between -90 and 90. */
  latitude: number;
  /** Degrees east of Greenwich, between -180 and 180. */
  longitude: number;
}

/**
 * A circle on the map.
 *
 * The schema only describes circles. A more exact shape is a mapping feature
 * and belongs to the navigation mission type (EXPD-039), not to the contract.
 */
export interface GeoCircle {
  centre: GeoPoint;
  /** How far the circle reaches from its centre, in metres. */
  radiusMetres: number;
}

/** A whole-number range with both ends included. */
export interface IntRange {
  min: number;
  max: number;
}

/**
 * A reference to a file in the media library (EXPD-030).
 *
 * The definition stores the id and enough information to lay the file out
 * before it is fetched. It never stores a URL, because URLs are signed at
 * request time (EXPD-021) and would go stale inside a saved document.
 */
export interface MediaRef {
  mediaId: MediaId;
  kind: 'image' | 'audio' | 'video' | 'document';
  /** Text read aloud by a screen reader in place of the file. */
  altText?: string;
}

/**
 * Where a player has to be for something to happen.
 *
 * The definition only records the requirement. Deciding whether a player has
 * met it is engine work (EXPD-039).
 */
export interface LocationConstraint {
  /** The area the player has to be inside. */
  area: GeoCircle;
  /**
   * What to do when the device cannot get a good enough fix.
   *
   * `block`  The player cannot continue.
   * `warn`   The player is told, and may continue.
   * `ignore` The requirement is dropped for that player.
   */
  onPoorAccuracy: 'block' | 'warn' | 'ignore';
}

/** Every media kind, matching `MediaRef['kind']`. */
export const MEDIA_KINDS = ['image', 'audio', 'video', 'document'] as const;

/** Every poor-accuracy action, matching `LocationConstraint['onPoorAccuracy']`. */
export const POOR_ACCURACY_ACTIONS = ['block', 'warn', 'ignore'] as const;

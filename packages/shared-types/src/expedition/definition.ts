/**
 * The Expedition Definition: the whole contract in one document.
 *
 * Everything that plays, authors or generates an expedition reads and writes
 * this shape. The Studio writes it, the Creator web app writes a simpler
 * version of it, the AI builder generates it, the API stores it, the engine
 * runs it and the student app plays it.
 *
 * The document is self contained on purpose. Given one of these and the
 * mission type registry, the engine can run an expedition without asking the
 * database for anything else.
 */

import type { ExpeditionId, IsoTimestamp } from './common.ts';
import type { ExpeditionGraph } from './graph.ts';
import type { ExpeditionMetadata } from './metadata.ts';
import type { MissionInstance } from './mission.ts';
import type { ExpeditionRules } from './rules.ts';
import type { ScoringConfig } from './scoring.ts';

/** Where an expedition is in its life (EXPD-017, EXPD-031). */
export type ExpeditionStatus =
  /** Being worked on. It may be incomplete and may fail validation. */
  | 'draft'
  /** Finished and locked. A published revision is never edited in place. */
  | 'published'
  /** Retired. It cannot be run again, and old results still point at it. */
  | 'archived';

/** Every expedition status. */
export const EXPEDITION_STATUSES = ['draft', 'published', 'archived'] as const;

/** One complete expedition. */
export interface ExpeditionDefinition {
  /**
   * The version of the schema this document is written against.
   *
   * Written by whoever saved the document. A reader checks it before reading
   * anything else. See `version.ts`.
   */
  schemaVersion: string;

  /** The expedition's own id. Stays the same across every revision. */
  id: ExpeditionId;

  /**
   * The revision number of this expedition, counting from one.
   *
   * It goes up by one each time a revision is published. Two documents with
   * the same `id` and the same `definitionVersion` are the same expedition.
   * EXPD-017 owns this counter.
   */
  definitionVersion: number;

  status: ExpeditionStatus;

  /** When this revision was published. Absent while the status is `draft`. */
  publishedAt?: IsoTimestamp;

  /** The descriptive part. Has no effect on play. */
  metadata: ExpeditionMetadata;

  /**
   * Every mission placed in this expedition.
   *
   * Missions are held here rather than inside the graph so that the graph is
   * only about shape. A mission node points at one of these by id. Every
   * mission listed here must be pointed at by exactly one mission node.
   */
  missions: MissionInstance[];

  /** The stops and the links between them. */
  graph: ExpeditionGraph;

  /** How the expedition is played. */
  rules: ExpeditionRules;

  /** How points are earned and lost. */
  scoring: ScoringConfig;
}

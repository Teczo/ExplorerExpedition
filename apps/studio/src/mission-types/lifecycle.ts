/**
 * Where a mission type is in its life, and what the builder offers next
 * (EXPD-031).
 *
 *   draft      → saved over as often as the author likes, then published.
 *   published  → frozen. A change is the next version: a new draft under the
 *                same key, copied from this one.
 *
 * The API holds every one of these rules. The builder asks them here first,
 * so it offers only what the API would accept. Pure functions, so a test can
 * hold them without a browser.
 */

import {
  compareMissionTypeVersions,
  highestMissionTypeVersion,
  nextMissionTypeVersion,
} from '@explorer/shared-types';

import type { MissionTypeView } from './api.ts';

/** What the builder offers for the type it has open. */
export type Lifecycle =
  /** Not saved yet. Save it first. */
  | { readonly kind: 'new' }
  /** This organisation's draft. `publishable` is false while `reason` says why. */
  | { readonly kind: 'draft'; readonly publishable: boolean; readonly reason: string | null }
  /**
   * This organisation's published type. `openDraft` is the draft of the same
   * key, when there is one: a key has one draft at a time, so that is the
   * next version and no other can be started.
   */
  | {
      readonly kind: 'published';
      readonly openDraft: MissionTypeView | null;
      readonly suggestedVersion: string;
    }
  /** The platform's. Read here, not changed. */
  | { readonly kind: 'platform' };

/** Every version of one key this organisation can see, lowest first. */
export function versionsOf(
  types: readonly MissionTypeView[],
  key: string,
): MissionTypeView[] {
  return types
    .filter((type) => type.key === key)
    .sort((a, b) => compareMissionTypeVersions(a.version, b.version) ?? 0);
}

/** What the form holds, as far as publishing is concerned. */
export interface FormState {
  /** How many problems the form has. */
  readonly issues: number;
  /** True when the form holds something that was not saved. */
  readonly unsaved: boolean;
}

/** What the builder offers for `existing`, given the form and every type the list holds. */
export function lifecycleOf(
  existing: MissionTypeView | null,
  form: FormState,
  types: readonly MissionTypeView[],
): Lifecycle {
  if (existing === null) {
    return { kind: 'new' };
  }
  if (existing.owner === 'platform') {
    return { kind: 'platform' };
  }
  if (existing.status === 'draft') {
    const reason =
      form.issues > 0
        ? 'Fix the problems above first.'
        : form.unsaved
          ? 'Save the draft first. What is published is what was saved.'
          : null;
    return { kind: 'draft', publishable: reason === null, reason };
  }

  const siblings = versionsOf(types, existing.key);
  const openDraft =
    siblings.find((type) => type.owner === 'organisation' && type.status === 'draft') ?? null;
  const highest =
    highestMissionTypeVersion([existing.version, ...siblings.map((type) => type.version)]) ??
    existing.version;
  return {
    kind: 'published',
    openDraft,
    suggestedVersion: nextMissionTypeVersion(highest, 'minor') ?? highest,
  };
}

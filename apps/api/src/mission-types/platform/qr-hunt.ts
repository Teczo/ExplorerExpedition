/**
 * The QR hunt mission type (EXPD-032).
 *
 * Physical QR markers stuck up around a site. A team scans them with the
 * student app (EXPD-043) and the phone hands in every code it has scanned
 * for the mission so far. This file judges that list.
 *
 * One type, three uses, chosen by the author with `purpose`:
 *
 *   - **`discovery`** — find markers in any order. The mission is done once
 *     `foundToComplete` of them are found, or all of them when that is left
 *     out. Finding some of them is partial progress.
 *   - **`progression`** — find the markers in the order they are listed. A
 *     scan only counts when it is the next marker in the trail, so a team
 *     that skips ahead has to come back. Leaving out a scan that did not
 *     count means a later scan in the right order still finishes the trail.
 *   - **`validation`** — prove the team is standing somewhere. Any one of the
 *     listed markers finishes the mission. A mission that is really about
 *     something else can use one to check the team got there.
 *
 * **Codes are compared trimmed and without case.** A printed marker carries
 * its code in writing under the square too, so a phone whose camera will not
 * focus can type it in, and a typed `lib-01` has to match `LIB-01`. The
 * consequence is that two markers whose codes differ only in case are the
 * same marker; the first one listed is kept.
 *
 * **What the schema cannot say.** The config schema subset has no
 * conditionals and cannot compare two fields (EXPD-009). So
 * `foundToComplete` is read only for `discovery`, and a value larger than
 * the number of markers means all of them. Both are rules of this file, not
 * refusals.
 *
 * **Feedback never names a marker the team has not found.** It says how many
 * are found and how many are needed, and nothing about where the rest are.
 * Hints are the author's to write.
 *
 * Pure, like every behaviour: no clock, no network, nothing kept between
 * calls.
 */

import { defineMissionType, type MissionTypeEntry } from '@explorer/engine';
import type { JsonObject, MissionTypeAuthoring } from '@explorer/shared-types';

/** The key an expedition pins to. */
export const QR_HUNT_KEY = 'qr-hunt';

/** The version this file judges. */
export const QR_HUNT_VERSION = '1.0.0';

/** What a QR hunt is for. */
export type QrHuntPurpose = 'discovery' | 'progression' | 'validation';

/** Every purpose, in the order the Studio offers them. */
export const QR_HUNT_PURPOSES = [
  'discovery',
  'progression',
  'validation',
] as const satisfies readonly QrHuntPurpose[];

/** The most markers one mission may hold. */
export const MAX_QR_MARKERS = 200;

/** The longest code a marker may encode. */
export const MAX_QR_CODE_LENGTH = 200;

/**
 * The most scans one submission may carry.
 *
 * Twice the markers, so a team that scanned every marker and a few wrong
 * codes besides is never refused for it.
 */
export const MAX_QR_SCANS = MAX_QR_MARKERS * 2;

/** One marker, as the author wrote it. */
interface Marker {
  /** The code as the author wrote it. What `detail.found` reports. */
  readonly code: string;
  /** The code as it is compared. */
  readonly key: string;
}

/** What `prepare` makes of a config, once per mission. */
export interface PreparedQrHunt {
  readonly purpose: QrHuntPurpose;
  /** The markers in the author's order, with repeats taken out. */
  readonly markers: readonly Marker[];
  /** Markers by comparison key, for everything but the trail's order. */
  readonly byKey: ReadonlyMap<string, Marker>;
  /** How many markers finish the mission. */
  readonly needed: number;
}

/** The form a code is compared in. */
export function qrCodeKey(code: string): string {
  return code.trim().toLowerCase();
}

function isPurpose(value: unknown): value is QrHuntPurpose {
  return typeof value === 'string' && (QR_HUNT_PURPOSES as readonly string[]).includes(value);
}

/** Turns an author's config into the markers a submission is judged against. */
export function prepareQrHunt(config: JsonObject): PreparedQrHunt {
  const purpose = isPurpose(config['purpose']) ? config['purpose'] : 'discovery';

  const markers: Marker[] = [];
  const byKey = new Map<string, Marker>();
  const raw = Array.isArray(config['markers']) ? config['markers'] : [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      continue;
    }
    const code = entry['code'];
    if (typeof code !== 'string') {
      continue;
    }
    const key = qrCodeKey(code);
    if (key === '' || byKey.has(key)) {
      continue;
    }
    const marker = { code, key };
    markers.push(marker);
    byKey.set(key, marker);
  }

  let needed = markers.length;
  if (purpose === 'validation') {
    needed = Math.min(1, markers.length);
  } else if (purpose === 'discovery') {
    const asked = config['foundToComplete'];
    if (typeof asked === 'number' && Number.isInteger(asked) && asked > 0) {
      needed = Math.min(asked, markers.length);
    }
  }

  return { purpose, markers, byKey, needed };
}

/** The markers a list of scans found, in the order they count. */
function markersFound(hunt: PreparedQrHunt, scanned: readonly string[]): Marker[] {
  if (hunt.purpose === 'progression') {
    // Walk the trail. A scan counts only when it is the next marker.
    let next = 0;
    for (const code of scanned) {
      const marker = hunt.markers[next];
      if (marker !== undefined && qrCodeKey(code) === marker.key) {
        next += 1;
      }
    }
    return hunt.markers.slice(0, next);
  }

  const found = new Map<string, Marker>();
  for (const code of scanned) {
    const marker = hunt.byKey.get(qrCodeKey(code));
    if (marker !== undefined && !found.has(marker.key)) {
      found.set(marker.key, marker);
    }
  }
  return [...found.values()];
}

function feedbackFor(hunt: PreparedQrHunt, found: number, done: boolean): string {
  if (hunt.purpose === 'validation') {
    return done ? 'Marker found.' : 'That code is not a marker for this mission.';
  }
  if (done) {
    return hunt.purpose === 'progression' ? 'Trail complete.' : 'All the markers you need are found.';
  }
  const unit = hunt.needed === 1 ? 'marker' : 'markers';
  return hunt.purpose === 'progression'
    ? `${found} of ${hunt.needed} ${unit} found in order.`
    : `${found} of ${hunt.needed} ${unit} found.`;
}

/** The QR hunt: its definition, and the code that judges a scan. */
export const qrHunt: MissionTypeEntry = defineMissionType({
  definition: {
    key: QR_HUNT_KEY,
    version: QR_HUNT_VERSION,
    name: 'QR hunt',
    description:
      'Teams scan QR markers placed around a site: to find them, to follow them in order, or to prove they reached a place.',
    status: 'published',
    capabilities: ['qr'],
    configSchema: {
      type: 'object',
      properties: {
        purpose: { type: 'string', enum: [...QR_HUNT_PURPOSES] },
        markers: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_QR_MARKERS,
          items: {
            type: 'object',
            properties: {
              code: {
                type: 'string',
                minLength: 1,
                maxLength: MAX_QR_CODE_LENGTH,
                // Something besides spaces. The platform anchors a pattern (EXPD-009).
                pattern: '\\s*\\S[\\s\\S]*',
              },
              label: { type: 'string', maxLength: 120 },
            },
            required: ['code'],
          },
        },
        foundToComplete: { type: 'integer', minimum: 1, maximum: MAX_QR_MARKERS },
      },
      required: ['purpose', 'markers'],
    },
    submissionSchema: {
      type: 'object',
      properties: {
        scanned: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_QR_SCANS,
          items: { type: 'string', minLength: 1, maxLength: MAX_QR_CODE_LENGTH },
        },
      },
      required: ['scanned'],
    },
    defaultConfig: {
      purpose: 'discovery',
      markers: [{ code: 'CHANGE-ME', label: 'Where this marker is stuck up' }],
    },
  },
  behaviour: {
    prepare(config: JsonObject): PreparedQrHunt {
      return prepareQrHunt(config);
    },
    evaluate({ config, prepared, submission }) {
      const hunt = (prepared as PreparedQrHunt | undefined) ?? prepareQrHunt(config);
      const raw = Array.isArray(submission['scanned']) ? submission['scanned'] : [];
      const scanned = raw.filter((code): code is string => typeof code === 'string');

      const found = markersFound(hunt, scanned);
      const done = hunt.needed > 0 && found.length >= hunt.needed;

      return {
        outcome: done ? 'correct' : 'incorrect',
        progress: hunt.needed === 0 ? 0 : Math.min(1, found.length / hunt.needed),
        feedback: feedbackFor(hunt, found.length, done),
        detail: {
          purpose: hunt.purpose,
          found: found.map((marker) => marker.code),
          needed: hunt.needed,
        },
      };
    },
  },
});

/**
 * What the Studio shows a new QR hunt mission starting with (EXPD-025).
 *
 * Kept beside the definition so that the platform row in migration 0009 has
 * one source to be checked against. The markers are never placed in the
 * layout: the codes are the answer.
 */
export const QR_HUNT_AUTHORING: MissionTypeAuthoring = {
  validationMethod: 'automatic',
  defaultScoring: { basePoints: 100, allowPartialCredit: true },
  studentLayout: {
    blocks: [
      { kind: 'brief' },
      { kind: 'instructions' },
      { kind: 'media' },
      { kind: 'timer' },
      { kind: 'hints' },
      { kind: 'submission' },
    ],
    submitLabel: 'Scan',
  },
};

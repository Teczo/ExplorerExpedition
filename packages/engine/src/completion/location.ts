/**
 * Was the team in the right place? (EXPD-011)
 *
 * "Location reached" is one of the six ways a mission is completed, and it is
 * the only one of the six the engine can decide without a mission type. A
 * `LocationConstraint` (EXPD-002) is on the mission rather than in the mission
 * type's settings, so it is in the one document the engine already holds, and
 * the check is the same for every type: are they inside the circle.
 *
 * That is why this file exists rather than each mission type carrying its own
 * copy. A type that wants more than a circle — a route walked in order, a
 * shape that is not round — brings that itself (EXPD-039); what is here is
 * the requirement every mission may carry.
 *
 * **The check runs before the mission type does, and it can stop it.** Work
 * handed in from the wrong place is not wrong work. It is work nobody looked
 * at, so it does not spend a try and it does not become an `incorrect` the
 * scoring engine (EXPD-012) can take points for. The team is told how far
 * away they are and may hand it in again when they arrive.
 *
 * **It is pure, and it reads no clock.** The maths is the haversine formula
 * on a sphere of one fixed radius, which is good to about half a percent —
 * far inside the accuracy of the phone that reported the position, and not
 * a number that can drift between two runs of the same simulation.
 */

import type { GeoCircle, LocationConstraint, ReportedPosition } from '@explorer/shared-types';

/**
 * The radius of the earth in metres, as the mean the haversine formula uses.
 *
 * One number rather than the real ellipsoid. The error is under half a
 * percent anywhere on the planet, and a mission's area is a circle an author
 * drew by hand around a statue.
 */
const EARTH_RADIUS_METRES = 6_371_008.8;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * How far apart two points are, in metres, over the ground.
 *
 * Exported because the navigation mission type (EXPD-039) and the mission
 * board's "how far to the next stop" both want the same number, and two
 * copies of this formula would be two chances to get it wrong.
 */
export function metresBetween(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): number {
  const fromLat = toRadians(from.latitude);
  const toLat = toRadians(to.latitude);
  const deltaLat = toRadians(to.latitude - from.latitude);
  const deltaLong = toRadians(to.longitude - from.longitude);

  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(fromLat) * Math.cos(toLat) * Math.sin(deltaLong / 2) ** 2;

  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Says whether a point is inside a circle drawn on the map. */
export function isInsideCircle(
  circle: GeoCircle,
  position: { latitude: number; longitude: number },
): boolean {
  return metresBetween(circle.centre, position) <= circle.radiusMetres;
}

/** What the location check found. */
export type LocationCheckCode =
  /** The mission names no area, so there was nothing to check. */
  | 'not-required'
  /** The team is inside it. */
  | 'met'
  /**
   * The reading was too rough to trust, and the mission says carry on anyway.
   *
   * `onPoorAccuracy: 'warn'`. The requirement counts as met and the team is
   * told the reading was poor.
   */
  | 'warned'
  /**
   * The reading was too rough to trust, and the mission says drop the
   * requirement for that team.
   *
   * `onPoorAccuracy: 'ignore'`. Nothing is checked and nothing is said.
   */
  | 'waived'
  /** The team is outside it. */
  | 'wrong-place'
  /**
   * The reading was too rough to trust, and the mission says stop.
   *
   * `onPoorAccuracy: 'block'`.
   */
  | 'poor-accuracy';

/** What the location check found, and what it means for the submission. */
export interface LocationCheck {
  readonly code: LocationCheckCode;
  /**
   * Whether the submission may be judged at all.
   *
   * False on `wrong-place` and `poor-accuracy`, and true on everything else.
   */
  readonly allowed: boolean;
  /**
   * Whether being in the right place was actually established.
   *
   * True on `met` and `warned` only. A mission whose type has no code to
   * judge with is completed by this being true, which is what makes reaching
   * a place one of the six ways to finish a mission.
   */
  readonly reached: boolean;
  /**
   * How far the team is from the middle of the area, in metres.
   *
   * Left out when there was no area or no position to measure from.
   */
  readonly metresFromCentre?: number;
  /** A sentence a person can read. */
  readonly message: string;
}

/**
 * Whether a reading is good enough to place a team inside an area.
 *
 * A reading is trusted when it could not on its own put the team outside a
 * circle they were reported inside — that is, when it is no rougher than the
 * circle is wide. A phone that says "somewhere within 200 metres" cannot
 * answer a question about a 50-metre circle, whichever way it answers it.
 *
 * A reading with no accuracy at all is trusted, because a device that says
 * nothing is far more common than one that is lying.
 */
function isAccurateEnough(circle: GeoCircle, position: ReportedPosition): boolean {
  return (
    position.accuracyMetres === undefined ||
    position.accuracyMetres <= circle.radiusMetres
  );
}

/** What a poor or missing reading costs, as the mission's own setting says. */
function onPoorReading(
  constraint: LocationConstraint,
  message: string,
): LocationCheck {
  switch (constraint.onPoorAccuracy) {
    case 'block':
      return { code: 'poor-accuracy', allowed: false, reached: false, message };
    case 'warn':
      return { code: 'warned', allowed: true, reached: true, message };
    case 'ignore':
      return {
        code: 'waived',
        allowed: true,
        reached: false,
        message: 'This mission does not mind where the team is when a device cannot say.',
      };
  }
}

/**
 * Checks one reported position against one mission's area.
 *
 * `constraint` is `null` for a mission that may be done anywhere, and
 * `position` is left out by a submission that carried no reading. The two
 * cases are different: the first has nothing to check, and the second has
 * something to check and no way to check it, so the mission's own
 * `onPoorAccuracy` decides what that costs.
 */
export function checkMissionLocation(
  constraint: LocationConstraint | null,
  position?: ReportedPosition,
): LocationCheck {
  if (constraint === null) {
    return {
      code: 'not-required',
      allowed: true,
      reached: false,
      message: 'This mission may be done anywhere.',
    };
  }

  if (position === undefined) {
    return onPoorReading(
      constraint,
      'The device did not say where the team was, and this mission is tied to a place.',
    );
  }

  const metresFromCentre = metresBetween(constraint.area.centre, position);

  if (!isAccurateEnough(constraint.area, position)) {
    const check = onPoorReading(
      constraint,
      `The device could only place the team to within ${String(position.accuracyMetres)} ` +
        `metres, and the mission's area is ${String(constraint.area.radiusMetres)} metres ` +
        'across from its middle.',
    );
    return { ...check, metresFromCentre };
  }

  if (metresFromCentre > constraint.area.radiusMetres) {
    return {
      code: 'wrong-place',
      allowed: false,
      reached: false,
      metresFromCentre,
      message:
        `The team is ${String(Math.round(metresFromCentre))} metres from the middle of ` +
        `this mission's area, which reaches ${String(constraint.area.radiusMetres)} metres.`,
    };
  }

  return {
    code: 'met',
    allowed: true,
    reached: true,
    metresFromCentre,
    message: 'The team is where the mission says they have to be.',
  };
}

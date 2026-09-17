/**
 * Where a device says it is (EXPD-011).
 *
 * A mission may carry a `LocationConstraint` (EXPD-002), which says where a
 * team has to be for their work to count. This is the other half of that: the
 * reading a phone sends up with a submission, so the engine can say whether
 * they were there.
 *
 * It is here rather than in the engine because the student app builds one
 * (EXPD-039, EXPD-043) and the API carries it (EXPD-020), and neither of
 * those depends on the engine. Deciding whether it satisfies a constraint is
 * the engine's, because that is a game rule.
 *
 * It is not a fix the platform trusts. A phone can be told to report any
 * position at all, so a mission whose whole answer is a place is a mission a
 * determined student can pass from the bus. That is a known limit, written
 * down here rather than left to be found, and closing it is a product
 * decision no ticket has made.
 */

/** A position as a device reported it. */
export interface ReportedPosition {
  /** Degrees north of the equator, between -90 and 90. */
  readonly latitude: number;
  /** Degrees east of Greenwich, between -180 and 180. */
  readonly longitude: number;
  /**
   * How far out the reading could be, in metres.
   *
   * Left out when the device did not say. A reading with no accuracy is
   * treated as a good one, because a device that reports no accuracy is far
   * more common than a device that is lying about it, and the mission's own
   * `onPoorAccuracy` is what decides what a bad reading costs.
   */
  readonly accuracyMetres?: number;
  /**
   * When the device took the reading, as an ISO 8601 string in UTC.
   *
   * Left out when the device did not say. The engine does not read it: it
   * holds no clock, so it has nothing to compare it with. It is carried so
   * that a submission queued offline (EXPD-048) still says where the team was
   * when they made it, rather than where they were when signal came back.
   */
  readonly takenAt?: string;
}

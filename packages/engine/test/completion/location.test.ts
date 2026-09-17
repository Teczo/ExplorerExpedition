/**
 * Was the team in the right place.
 *
 * Two halves. The arithmetic, because a distance that is wrong puts a class
 * in the wrong field; and what each answer costs a submission, because
 * "outside the area" and "the phone could not say" are different things and
 * the mission's own setting decides the second one.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  checkMissionLocation,
  isInsideCircle,
  metresBetween,
} from '../../src/completion/location.ts';
import { mustBeAt, square } from './support.ts';

describe('how far apart two points are', () => {
  it('is nothing at all for the same point', () => {
    assert.equal(metresBetween(square.centre, square.centre), 0);
  });

  it('measures a known distance to within a metre', () => {
    // A tenth of a degree of latitude is 11.1 km, near enough anywhere.
    const north = { latitude: square.centre.latitude + 0.1, longitude: square.centre.longitude };
    const metres = metresBetween(square.centre, north);
    assert.ok(Math.abs(metres - 11_119.5) < 1, `${String(metres)} metres`);
  });

  it('does not care which way round it is asked', () => {
    const other = { latitude: 48.8584, longitude: 2.2945 };
    assert.equal(
      Math.round(metresBetween(square.centre, other)),
      Math.round(metresBetween(other, square.centre)),
    );
  });

  it('crosses the date line without going the long way round', () => {
    const west = { latitude: 0, longitude: -179.99 };
    const east = { latitude: 0, longitude: 179.99 };
    assert.ok(metresBetween(west, east) < 3000);
  });

  it('puts a point exactly on the edge of a circle inside it', () => {
    // The edge belongs to the circle. A team standing on the line is there.
    const edge = { latitude: square.centre.latitude + 0.0004, longitude: square.centre.longitude };
    const exactly = { centre: square.centre, radiusMetres: metresBetween(square.centre, edge) };
    assert.equal(isInsideCircle(exactly, edge), true);
  });
});

describe('a mission that may be done anywhere', () => {
  it('has nothing to check, and stops nothing', () => {
    const check = checkMissionLocation(null);
    assert.equal(check.code, 'not-required');
    assert.equal(check.allowed, true);
    // It is not a place reached either. Nothing was reached.
    assert.equal(check.reached, false);
  });
});

describe('a mission tied to a place', () => {
  const inside = { latitude: 51.5081, longitude: -0.1281 };
  const outside = { latitude: 51.5045, longitude: -0.1275 };

  it('lets a team inside it carry on', () => {
    const check = checkMissionLocation(mustBeAt(), inside);
    assert.equal(check.code, 'met');
    assert.equal(check.allowed, true);
    assert.equal(check.reached, true);
    assert.ok((check.metresFromCentre ?? Infinity) < 50);
  });

  it('stops a team outside it, and says how far away they are', () => {
    const check = checkMissionLocation(mustBeAt(), outside);
    assert.equal(check.code, 'wrong-place');
    assert.equal(check.allowed, false);
    assert.equal(check.reached, false);
    assert.ok((check.metresFromCentre ?? 0) > 300);
  });

  it('stops a team outside it whatever the poor-accuracy setting says', () => {
    // `onPoorAccuracy` is about a reading nobody can trust. A trustworthy
    // reading that puts the team in the next street is not that.
    for (const onPoor of ['block', 'warn', 'ignore'] as const) {
      assert.equal(checkMissionLocation(mustBeAt(square, onPoor), outside).code, 'wrong-place');
    }
  });
});

describe('a reading nobody can trust', () => {
  /** A phone that can only place the team to within two hundred metres. */
  const vague = { latitude: 51.5081, longitude: -0.1281, accuracyMetres: 200 };

  it('stops the submission when the mission says block', () => {
    const check = checkMissionLocation(mustBeAt(square, 'block'), vague);
    assert.equal(check.code, 'poor-accuracy');
    assert.equal(check.allowed, false);
    assert.equal(check.reached, false);
  });

  it('counts as being there when the mission says warn', () => {
    const check = checkMissionLocation(mustBeAt(square, 'warn'), vague);
    assert.equal(check.code, 'warned');
    assert.equal(check.allowed, true);
    assert.equal(check.reached, true);
  });

  it('drops the requirement when the mission says ignore', () => {
    const check = checkMissionLocation(mustBeAt(square, 'ignore'), vague);
    assert.equal(check.code, 'waived');
    assert.equal(check.allowed, true);
    // Dropped is not reached: nothing was established either way.
    assert.equal(check.reached, false);
  });

  it('trusts a reading that says nothing about its own accuracy', () => {
    const check = checkMissionLocation(mustBeAt(), { latitude: 51.5081, longitude: -0.1281 });
    assert.equal(check.code, 'met');
  });

  it('trusts a reading no rougher than the circle is wide', () => {
    const edgy = { latitude: 51.5081, longitude: -0.1281, accuracyMetres: 50 };
    assert.equal(checkMissionLocation(mustBeAt(), edgy).code, 'met');
  });
});

describe('a submission that carried no position at all', () => {
  it('is treated the same way as a reading nobody can trust', () => {
    assert.equal(checkMissionLocation(mustBeAt(square, 'block')).code, 'poor-accuracy');
    assert.equal(checkMissionLocation(mustBeAt(square, 'warn')).code, 'warned');
    assert.equal(checkMissionLocation(mustBeAt(square, 'ignore')).code, 'waived');
  });

  it('says so in words a person can read', () => {
    const check = checkMissionLocation(mustBeAt(square, 'block'));
    assert.match(check.message, /did not say where the team was/);
  });
});

/**
 * Versions of one mission type (EXPD-031).
 *
 * The API refuses a new version that is not higher than every one it holds,
 * and the Studio suggests the next one. Both read these helpers.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  compareMissionTypeVersions,
  highestMissionTypeVersion,
  nextMissionTypeVersion,
} from '../../src/mission-type/index.ts';

describe('compareMissionTypeVersions', () => {
  it('orders by major, then minor, then patch', () => {
    assert.ok((compareMissionTypeVersions('2.0.0', '1.9.9') ?? 0) > 0);
    assert.ok((compareMissionTypeVersions('1.2.0', '1.10.0') ?? 0) < 0);
    assert.ok((compareMissionTypeVersions('1.0.1', '1.0.0') ?? 0) > 0);
    assert.equal(compareMissionTypeVersions('1.0.0', '1.0.0'), 0);
  });

  it('reads numbers as numbers, not as text', () => {
    assert.ok((compareMissionTypeVersions('1.10.0', '1.9.0') ?? 0) > 0);
  });

  it('answers null for something that is not a version', () => {
    assert.equal(compareMissionTypeVersions('1.0', '1.0.0'), null);
    assert.equal(compareMissionTypeVersions('1.0.0', 'v2'), null);
  });
});

describe('highestMissionTypeVersion', () => {
  it('finds the highest, skipping anything that is not a version', () => {
    assert.equal(highestMissionTypeVersion(['1.2.0', 'nope', '1.10.0', '1.9.3']), '1.10.0');
  });

  it('answers null for none', () => {
    assert.equal(highestMissionTypeVersion([]), null);
  });
});

describe('nextMissionTypeVersion', () => {
  it('raises one part and zeroes the parts after it', () => {
    assert.equal(nextMissionTypeVersion('1.4.2', 'major'), '2.0.0');
    assert.equal(nextMissionTypeVersion('1.4.2', 'minor'), '1.5.0');
    assert.equal(nextMissionTypeVersion('1.4.2', 'patch'), '1.4.3');
  });

  it('answers null for something that is not a version', () => {
    assert.equal(nextMissionTypeVersion('one', 'minor'), null);
  });
});

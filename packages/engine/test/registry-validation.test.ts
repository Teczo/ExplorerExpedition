/**
 * The check the Expedition Definition validator could not do.
 *
 * EXPD-002 says of `MissionInstance.config`: only the mission type knows the
 * right shape, so only the registry can check it. These tests are what makes
 * that sentence true, and they also hold the paths to the same shape EXPD-002
 * uses, so the Studio puts a problem from either check on the same field.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MissionTypeNotRegisteredError,
  createMissionTypeRegistry,
} from '../src/mission-types/index.ts';

import {
  deprecatedType,
  draftType,
  expeditionOf,
  missionOf,
  shelfTidy,
  wordHunt,
  wordHuntV2,
} from './support/mission-types.ts';

const registry = createMissionTypeRegistry([
  wordHunt,
  wordHuntV2,
  shelfTidy,
  draftType,
  deprecatedType,
]);

describe('checking one mission config', () => {
  it('accepts settings that match the type', () => {
    const result = registry.validateConfig('word-hunt', '1.0.0', {
      words: ['gate', 'oak'],
      caseSensitive: true,
    });
    assert.equal(result.valid, true);
  });

  it('refuses settings that do not, and says which field', () => {
    const result = registry.validateConfig('word-hunt', '1.0.0', { words: [] });
    assert.equal(result.valid, false);
    assert.equal(result.valid === false && result.issues[0]?.path, 'config.words');
    assert.equal(result.valid === false && result.issues[0]?.code, 'too-short');
  });

  it('checks against the version asked for, not the newest one', () => {
    const settings = { words: ['gate'], caseSensitive: false };
    assert.equal(registry.validateConfig('word-hunt', '1.0.0', settings).valid, true);
    // Version 2 added a field and made it required, which is why it is a new
    // version rather than an edit to the old one.
    assert.equal(registry.validateConfig('word-hunt', '2.0.0', settings).valid, false);
  });

  it('refuses to guess when the type is not registered', () => {
    assert.throws(
      () => registry.validateConfig('no-such-type', '1.0.0', {}),
      MissionTypeNotRegisteredError,
    );
  });
});

describe('checking one submission payload', () => {
  it('accepts a payload that matches the type', () => {
    assert.equal(
      registry.validateSubmission('word-hunt', '1.0.0', { found: ['gate'] }).valid,
      true,
    );
  });

  it('refuses one that does not', () => {
    const result = registry.validateSubmission('word-hunt', '1.0.0', {});
    assert.equal(result.valid, false);
    assert.equal(result.valid === false && result.issues[0]?.path, 'payload.found');
  });
});

describe('checking a mission placed in an expedition', () => {
  it('accepts a sound one', () => {
    const mission = missionOf('word-hunt', '1.0.0', { words: ['gate'] });
    assert.equal(registry.validateMission(mission).valid, true);
  });

  it('reports a bad config under the mission it belongs to', () => {
    const mission = missionOf('word-hunt', '1.0.0', { words: ['gate'], extra: 1 });
    const result = registry.validateMission(mission, 'missions[4]');
    assert.equal(result.valid, false);
    assert.equal(result.valid === false && result.issues[0]?.path, 'missions[4].config.extra');
  });
});

describe('checking a whole expedition', () => {
  it('accepts one whose missions all match their types', () => {
    const expedition = expeditionOf([
      missionOf('word-hunt', '1.0.0', { words: ['gate'] }),
      missionOf('shelf-tidy', '1.0.0', { shelf: 'by the door' }),
    ]);
    assert.equal(registry.validateExpedition(expedition).valid, true);
  });

  it('numbers the missions the way the EXPD-002 validator does', () => {
    const expedition = expeditionOf([
      missionOf('word-hunt', '1.0.0', { words: ['gate'] }),
      missionOf('word-hunt', '1.0.0', { words: 'gate' }),
    ]);
    const result = registry.validateExpedition(expedition);
    assert.equal(result.valid, false);
    assert.equal(result.valid === false && result.issues[0]?.path, 'missions[1].config.words');
  });

  it('reports every mission with a problem, not just the first', () => {
    const expedition = expeditionOf([
      missionOf('word-hunt', '1.0.0', {}),
      missionOf('word-hunt', '1.0.0', { words: ['gate'] }),
      missionOf('shelf-tidy', '1.0.0', {}),
    ]);
    const result = registry.validateExpedition(expedition);
    assert.deepEqual(
      result.valid === false ? result.issues.map((issue) => issue.path) : [],
      ['missions[0].config.words', 'missions[2].config.shelf'],
    );
  });

  it('accepts an expedition with no missions in it yet', () => {
    assert.equal(registry.validateExpedition(expeditionOf([])).valid, true);
  });
});

describe('a mission naming a type nobody registered', () => {
  const expedition = expeditionOf([missionOf('ghost-hunt', '1.0.0', {})]);

  it('is refused, and the message says what is registered instead', () => {
    const result = registry.validateExpedition(expedition);
    assert.equal(result.valid, false);
    const issue = result.valid === false ? result.issues[0] : undefined;
    assert.equal(issue?.code, 'unknown-mission-type');
    assert.equal(issue?.path, 'missions[0].missionTypeId');
    assert.match(issue?.message ?? '', /No version of it is registered/);
  });

  it('lists the versions that do exist when the key is known', () => {
    const wrongVersion = expeditionOf([missionOf('word-hunt', '9.9.9', {})]);
    const result = registry.validateExpedition(wrongVersion);
    const issue = result.valid === false ? result.issues[0] : undefined;
    assert.match(issue?.message ?? '', /Registered versions of it are: 1\.0\.0, 2\.0\.0/);
  });

  it('is allowed while the expedition is a draft', () => {
    // `mission_instance.mission_type_id` is nullable for exactly this case:
    // an author sketching a mission against a type that is still being built.
    assert.equal(
      registry.validateExpedition(expedition, { allowUnregistered: true }).valid,
      true,
    );
  });
});

describe('a mission pinned to a draft or superseded type', () => {
  it('is refused by default', () => {
    const expedition = expeditionOf([
      missionOf('half-built', '1.0.0', { shelf: 'by the door' }),
    ]);
    const result = registry.validateExpedition(expedition);
    assert.equal(result.valid, false);
    const issue = result.valid === false ? result.issues[0] : undefined;
    assert.equal(issue?.path, 'missions[0].missionTypeVersion');
    assert.match(issue?.message ?? '', /is draft/);
  });

  it('is allowed when the caller says so, for an expedition still being built', () => {
    const expedition = expeditionOf([
      missionOf('half-built', '1.0.0', { shelf: 'by the door' }),
      missionOf('old-fashioned', '1.0.0', { shelf: 'by the door' }),
    ]);
    assert.equal(
      registry.validateExpedition(expedition, {
        status: { includeDraft: true, includeDeprecated: true },
      }).valid,
      true,
    );
  });

  it('still checks the settings of a type it complained about', () => {
    const expedition = expeditionOf([missionOf('half-built', '1.0.0', {})]);
    const result = registry.validateExpedition(expedition);
    assert.deepEqual(
      result.valid === false ? result.issues.map((issue) => issue.code) : [],
      ['unknown-mission-type', 'missing'],
    );
  });
});

describe('what an expedition needs from a phone', () => {
  it('is the union over its missions, with nothing counted twice', () => {
    const expedition = expeditionOf([
      missionOf('word-hunt', '1.0.0', { words: ['gate'] }),
      missionOf('shelf-tidy', '1.0.0', { shelf: 'by the door' }),
    ]);
    assert.deepEqual(registry.capabilitiesFor(expedition), ['camera']);
  });

  it('is empty for an expedition with no missions', () => {
    assert.deepEqual(registry.capabilitiesFor(expeditionOf([])), []);
  });

  it('ignores a mission whose type is not registered, rather than throwing', () => {
    const expedition = expeditionOf([
      missionOf('ghost-hunt', '1.0.0', {}),
      missionOf('word-hunt', '1.0.0', { words: ['gate'] }),
    ]);
    assert.deepEqual(registry.capabilitiesFor(expedition), ['camera']);
  });
});

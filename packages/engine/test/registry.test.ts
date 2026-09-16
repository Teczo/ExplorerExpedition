/**
 * Holding mission types, and refusing the ones that would break later.
 *
 * Everything here is about the registry as a container: what it takes, what
 * it refuses, and what it hands back. Checking a mission against a type is
 * `registry-validation.test.ts`, and the promise that a new type needs no
 * engine change is `plug-in.test.ts`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MissionTypeNotRegisteredError,
  MissionTypeRegistrationError,
  MissionTypeRegistry,
  createMissionTypeRegistry,
} from '../src/mission-types/index.ts';

import {
  deprecatedType,
  draftType,
  shelfTidy,
  wordHunt,
  wordHuntV2,
} from './support/mission-types.ts';

describe('putting a mission type in', () => {
  it('starts empty', () => {
    const registry = new MissionTypeRegistry();
    assert.equal(registry.size, 0);
    assert.deepEqual(registry.keys(), []);
    assert.deepEqual(registry.refs(), []);
  });

  it('holds a type once it is registered', () => {
    const registry = createMissionTypeRegistry([wordHunt]);
    assert.equal(registry.size, 1);
    assert.equal(registry.has('word-hunt', '1.0.0'), true);
    assert.equal(registry.get('word-hunt', '1.0.0')?.ref, 'word-hunt@1.0.0');
  });

  it('holds two versions of one type as two entries', () => {
    const registry = createMissionTypeRegistry([wordHunt, wordHuntV2]);
    assert.equal(registry.size, 2);
    assert.deepEqual(registry.keys(), ['word-hunt']);
    assert.deepEqual(registry.versionsOf('word-hunt'), ['1.0.0', '2.0.0']);
  });

  it('takes a type with no behaviour, the way a Studio-built one arrives', () => {
    const registry = createMissionTypeRegistry([shelfTidy]);
    assert.equal(registry.behaviourFor('shelf-tidy', '1.0.0'), undefined);
  });

  it('can be chained, because registering returns the registry', () => {
    const registry = new MissionTypeRegistry().register(wordHunt).register(shelfTidy);
    assert.equal(registry.size, 2);
  });
});

describe('what it refuses to hold', () => {
  it('refuses the same key and version twice', () => {
    const registry = createMissionTypeRegistry([wordHunt]);
    assert.throws(
      () => registry.register(wordHunt),
      (error: unknown) => {
        assert.ok(error instanceof MissionTypeRegistrationError);
        assert.equal(error.ref, 'word-hunt@1.0.0');
        assert.match(error.message, /already registered/);
        return true;
      },
    );
  });

  it('refuses a type whose schema it could not run', () => {
    assert.throws(
      () =>
        createMissionTypeRegistry([
          {
            definition: {
              ...wordHunt.definition,
              key: 'broken',
              configSchema: { type: 'object', properties: { a: { $ref: '#' } } } as never,
            },
          },
        ]),
      (error: unknown) => {
        assert.ok(error instanceof MissionTypeRegistrationError);
        assert.equal(error.issues[0]?.code, 'unsupported-keyword');
        // The message carries the detail, so a failed start says what to fix.
        assert.match(error.message, /configSchema\.properties\.a\.\$ref/);
        return true;
      },
    );
  });

  it('refuses a type whose own starting settings fail its schema', () => {
    assert.throws(
      () =>
        createMissionTypeRegistry([
          {
            definition: { ...wordHunt.definition, key: 'wrong-start', defaultConfig: {} },
          },
        ]),
      MissionTypeRegistrationError,
    );
  });

  it('refuses a behaviour that cannot judge anything', () => {
    assert.throws(
      () =>
        createMissionTypeRegistry([
          { definition: shelfTidy.definition, behaviour: {} as never },
        ]),
      (error: unknown) => {
        assert.ok(error instanceof MissionTypeRegistrationError);
        assert.match(error.message, /no evaluate function/);
        return true;
      },
    );
  });

  it('survives a type too broken to name, and says so', () => {
    assert.throws(
      () => createMissionTypeRegistry([{ definition: null as never }]),
      (error: unknown) => {
        assert.ok(error instanceof MissionTypeRegistrationError);
        assert.equal(error.ref, '(unreadable)');
        return true;
      },
    );
  });

  it('keeps everything registered before the one that failed', () => {
    const registry = new MissionTypeRegistry();
    assert.throws(
      () => registry.registerAll([wordHunt, { definition: null as never }, shelfTidy]),
      MissionTypeRegistrationError,
    );
    assert.equal(registry.has('word-hunt', '1.0.0'), true);
    assert.equal(registry.has('shelf-tidy', '1.0.0'), false);
  });
});

describe('asking for a type that is not there', () => {
  it('answers undefined when asked softly', () => {
    const registry = createMissionTypeRegistry([wordHunt]);
    assert.equal(registry.get('word-hunt', '9.0.0'), undefined);
    assert.equal(registry.has('nothing-like-it', '1.0.0'), false);
  });

  it('throws when required, and lists what it does hold', () => {
    const registry = createMissionTypeRegistry([wordHunt, shelfTidy]);
    assert.throws(
      () => registry.require('word-hunt', '9.0.0'),
      (error: unknown) => {
        assert.ok(error instanceof MissionTypeNotRegisteredError);
        assert.equal(error.key, 'word-hunt');
        assert.equal(error.version, '9.0.0');
        assert.match(error.message, /shelf-tidy@1\.0\.0, word-hunt@1\.0\.0/);
        return true;
      },
    );
  });

  it('says plainly when it holds nothing at all', () => {
    assert.throws(
      () => new MissionTypeRegistry().require('word-hunt', '1.0.0'),
      /holds no mission types at all/,
    );
  });
});

describe('finding the version to author against', () => {
  it('offers the newest published version', () => {
    const registry = createMissionTypeRegistry([wordHuntV2, wordHunt]);
    assert.equal(registry.latest('word-hunt')?.definition.version, '2.0.0');
  });

  it('orders versions by number, not by text', () => {
    const registry = new MissionTypeRegistry().registerAll([
      { definition: { ...shelfTidy.definition, version: '10.0.0' } },
      { definition: { ...shelfTidy.definition, version: '2.0.0' } },
      { definition: { ...shelfTidy.definition, version: '1.0.0' } },
    ]);
    assert.deepEqual(registry.versionsOf('shelf-tidy'), ['1.0.0', '2.0.0', '10.0.0']);
    assert.equal(registry.latest('shelf-tidy')?.definition.version, '10.0.0');
  });

  it('does not offer a draft or a superseded type unless asked', () => {
    const registry = createMissionTypeRegistry([draftType, deprecatedType]);
    assert.equal(registry.latest('half-built'), undefined);
    assert.equal(registry.latest('old-fashioned'), undefined);
    assert.equal(registry.latest('half-built', { includeDraft: true })?.ref, 'half-built@1.0.0');
    assert.equal(
      registry.latest('old-fashioned', { includeDeprecated: true })?.ref,
      'old-fashioned@1.0.0',
    );
  });

  it('answers undefined for a key it has never heard of', () => {
    assert.equal(new MissionTypeRegistry().latest('word-hunt'), undefined);
    assert.deepEqual(new MissionTypeRegistry().versionsOf('word-hunt'), []);
  });
});

describe('listing what is held', () => {
  it('lists by key, then by version, oldest first', () => {
    const registry = createMissionTypeRegistry([wordHuntV2, shelfTidy, wordHunt]);
    assert.deepEqual(
      registry.list().map((held) => held.ref),
      ['shelf-tidy@1.0.0', 'word-hunt@1.0.0', 'word-hunt@2.0.0'],
    );
  });

  it('leaves out drafts and superseded types unless asked', () => {
    const registry = createMissionTypeRegistry([wordHunt, draftType, deprecatedType]);
    assert.deepEqual(registry.list().map((held) => held.ref), ['word-hunt@1.0.0']);
    assert.equal(registry.list({ includeDraft: true }).length, 2);
    assert.equal(
      registry.list({ includeDraft: true, includeDeprecated: true }).length,
      3,
    );
  });
});

describe('the settings a new mission starts with', () => {
  it('hands back what the type says', () => {
    const registry = createMissionTypeRegistry([wordHunt]);
    assert.deepEqual(registry.defaultConfigFor('word-hunt', '1.0.0'), {
      words: ['change-me'],
      caseSensitive: false,
    });
  });

  it('hands back a fresh copy, so one author cannot change what others get', () => {
    const registry = createMissionTypeRegistry([wordHunt]);
    const mine = registry.defaultConfigFor('word-hunt', '1.0.0') as { words: string[] };
    mine.words.push('mine');
    assert.deepEqual(registry.defaultConfigFor('word-hunt', '1.0.0'), {
      words: ['change-me'],
      caseSensitive: false,
    });
    assert.deepEqual(wordHunt.definition.defaultConfig, {
      words: ['change-me'],
      caseSensitive: false,
    });
  });
});

/**
 * The media library in the Studio (EXPD-030): deciding what a file is, the
 * three-step upload, and placing library files on a mission.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { ConfigSchema, JsonObject } from '@explorer/shared-types';

import { addNode, connect, openDocument, startingGraph, type GraphState, type MissionTypeChoice } from '../src/expeditions/graph.ts';
import {
  addMedia,
  issuesAt,
  issuesOfMission,
  moveMedia,
  removeMedia,
  setMediaAltText,
  type MissionTypeRef,
} from '../src/expeditions/properties.ts';
import {
  contentTypeOf,
  formatBytes,
  kindOf,
  mediaLibraryApi,
  nameFromFile,
  placeable,
  type LibraryItem,
} from '../src/media/library.ts';

const SCHEMA: ConfigSchema = {
  type: 'object',
  properties: {
    species: { type: 'string', title: 'Species', minLength: 1 },
    count: { type: 'integer', minimum: 0 },
  },
  required: ['species'],
  additionalProperties: false,
};

const TYPE: MissionTypeChoice & MissionTypeRef = {
  key: 'bird-count',
  version: '1.0.0',
  name: 'Bird count',
  description: 'Count the birds you see.',
  defaultConfig: { species: 'Robin' },
  configSchema: SCHEMA,
  validationMethod: 'teacher',
  defaultScoring: { basePoints: 10, allowPartialCredit: false, maxPoints: 20 },
};

/** Everything outside the graph a valid document needs, so only the graph is on trial. */
function document(graph: JsonObject = startingGraph() as unknown as JsonObject): JsonObject {
  return {
    schemaVersion: '1.1.0',
    id: 'expedition-1',
    definitionVersion: 1,
    status: 'draft',
    metadata: {
      title: 'A walk round the museum',
      summary: 'One mission, one stop.',
      locale: 'en-GB',
      ageRange: { min: 9, max: 11 },
      expectedDurationMinutes: { min: 30, max: 60 },
      subjects: [],
      tags: [],
      setting: 'indoor',
      authoring: {
        organisationId: 'org-1',
        createdBy: 'user-1',
        createdAt: '2026-05-12T10:00:00.000Z',
        updatedBy: 'user-1',
        updatedAt: '2026-05-12T10:00:00.000Z',
        source: 'studio',
      },
    },
    missions: [],
    graph,
    rules: {
      progression: 'open',
      allowSkip: false,
      teams: { size: { min: 2, max: 4 }, maxTeams: null, roles: [], requireFullTeamToStart: false },
      timing: { startMode: 'synchronised', endMode: 'teacher-ends' },
      hints: { enabled: false, tokensPerTeam: 0 },
      submissions: { requireReviewForAll: false, latePolicy: 'reject', allowOfflineQueue: true },
    },
    scoring: { rules: [], minimumTotal: 0, leaderboard: { visibility: 'live', tieBreaks: [] } },
  };
}

/** Start → one mission → finish, and the id of the mission. */
function line(): { state: GraphState; missionId: string } {
  const added = addNode(openDocument(document()), { kind: 'mission', type: TYPE }, 'start');
  const joined = connect(added.state, added.nodeId, 'finish');
  assert.ok(joined.ok);
  return { state: joined.state, missionId: joined.state.missions[0]!.id };
}

function file(id: string, fields: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id,
    kind: 'image',
    status: 'ready',
    name: `File ${id}`,
    altText: null,
    contentType: 'image/png',
    byteSize: 1000,
    createdAt: '2026-09-28T10:00:00.000Z',
    updatedAt: '2026-09-28T10:00:00.000Z',
    ...fields,
  };
}

describe('what a file is', () => {
  test('the browser’s type is used when it gives one', () => {
    assert.equal(contentTypeOf({ name: 'map.PNG', type: 'image/PNG' }), 'image/png');
    assert.equal(contentTypeOf({ name: 'sheet.pdf', type: 'application/pdf' }), 'application/pdf');
  });

  test('3D models are told by their extension, since browsers do not know them', () => {
    assert.equal(contentTypeOf({ name: 'statue.glb', type: '' }), 'model/gltf-binary');
    assert.equal(contentTypeOf({ name: 'statue.gltf', type: 'application/octet-stream' }), 'model/gltf+json');
    assert.equal(contentTypeOf({ name: 'Statue.USDZ', type: '' }), 'model/vnd.usdz+zip');
    assert.equal(contentTypeOf({ name: 'notes', type: '' }), null);
  });

  test('its kind follows the API’s rule', () => {
    assert.equal(kindOf('image/jpeg'), 'image');
    assert.equal(kindOf('audio/mpeg'), 'audio');
    assert.equal(kindOf('video/mp4'), 'video');
    assert.equal(kindOf('application/pdf'), 'document');
    assert.equal(kindOf('model/gltf-binary'), 'model');
    assert.equal(kindOf('font/woff2'), null);
  });

  test('a name and a size a person can read', () => {
    assert.equal(nameFromFile('Park map.final.png'), 'Park map.final');
    assert.equal(nameFromFile('.hidden'), '.hidden');
    assert.equal(formatBytes(null), '—');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(734_003), '717 KB');
    assert.equal(formatBytes(13_002_342), '12 MB');
  });

  test('only ready files are offered for a mission', () => {
    const items = [file('a'), file('b', { status: 'pending' }), file('c', { status: 'failed' })];
    assert.deepEqual(placeable(items).map((item) => item.id), ['a']);
  });
});

describe('uploading', () => {
  test('signs, PUTs the bytes to storage with the given headers, then asks the API to check', async () => {
    const calls: { path: string; init?: RequestInit }[] = [];
    const request = async <T,>(path: string, init?: RequestInit): Promise<T> => {
      calls.push({ path, ...(init === undefined ? {} : { init }) });
      if (path === '/media/library') {
        return {
          media: file('new', { status: 'pending', kind: 'model' }),
          upload: {
            method: 'PUT',
            url: 'https://blob.example/media/org/new?sp=c&sig=x',
            headers: { 'x-ms-blob-type': 'BlockBlob', 'content-type': 'model/gltf-binary' },
            expiresAt: '2026-09-28T10:15:00.000Z',
          },
        } as T;
      }
      return { media: file('new', { kind: 'model' }) } as T;
    };
    const puts: { url: string; init?: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      puts.push({ url, ...(init === undefined ? {} : { init }) });
      return new Response(null, { status: 201 });
    }) as typeof fetch;

    const steps: string[] = [];
    const blob = Object.assign(new Blob(['glTF']), { name: 'statue.glb' });
    const done = await mediaLibraryApi(request, fakeFetch).upload(
      blob,
      { name: ' Statue ', altText: '' },
      (step) => steps.push(step),
    );

    assert.equal(done.status, 'ready');
    assert.deepEqual(steps, ['signing', 'uploading', 'checking']);
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
      kind: 'model',
      contentType: 'model/gltf-binary',
      name: 'Statue',
    });
    assert.equal(puts[0]?.url, 'https://blob.example/media/org/new?sp=c&sig=x');
    assert.equal(puts[0]?.init?.method, 'PUT');
    assert.equal(calls[1]?.path, '/media/library/new/complete');
  });

  test('a refused PUT stops before asking the API to check', async () => {
    const paths: string[] = [];
    const request = async <T,>(path: string): Promise<T> => {
      paths.push(path);
      return {
        media: file('new', { status: 'pending' }),
        upload: { method: 'PUT', url: 'https://blob.example/x', headers: {}, expiresAt: '' },
      } as T;
    };
    const refusing = (async () => new Response(null, { status: 403 })) as typeof fetch;
    const blob = Object.assign(new Blob(['png'], { type: 'image/png' }), { name: 'map.png' });
    await assert.rejects(
      mediaLibraryApi(request, refusing).upload(blob, { name: 'Map', altText: '' }),
      /Storage refused the file \(403\)/,
    );
    assert.deepEqual(paths, ['/media/library']);
  });

  test('a file the library does not take is refused before anything is sent', async () => {
    let called = false;
    const request = async <T,>(): Promise<T> => {
      called = true;
      return null as T;
    };
    const blob = Object.assign(new Blob(['x'], { type: 'font/woff2' }), { name: 'font.woff2' });
    await assert.rejects(mediaLibraryApi(request).upload(blob, { name: 'Font', altText: '' }));
    assert.equal(called, false);
  });
});

describe('media on a mission', () => {
  test('adds library files in order, once each, with their alt text', () => {
    const { state, missionId } = line();
    let next = addMedia(state, missionId, file('a', { altText: 'The pond' }));
    next = addMedia(next, missionId, file('b', { kind: 'model' }));
    next = addMedia(next, missionId, file('a'));
    assert.deepEqual(next.missions[0]!.media, [
      { mediaId: 'a', kind: 'image', altText: 'The pond' },
      { mediaId: 'b', kind: 'model' },
    ]);
    assert.deepEqual(issuesOfMission(next, missionId, TYPE), []);
  });

  test('moves, retitles and removes one file without touching the others', () => {
    const { state, missionId } = line();
    let next = addMedia(addMedia(state, missionId, file('a')), missionId, file('b'));
    next = moveMedia(next, missionId, 'b', -1);
    assert.deepEqual(next.missions[0]!.media.map((ref) => ref.mediaId), ['b', 'a']);
    // The first cannot go further up.
    assert.deepEqual(moveMedia(next, missionId, 'b', -1).missions[0]!.media, next.missions[0]!.media);

    next = setMediaAltText(next, missionId, 'a', 'A map');
    assert.equal(next.missions[0]!.media[1]!.altText, 'A map');
    next = setMediaAltText(next, missionId, 'a', '');
    assert.equal('altText' in next.missions[0]!.media[1]!, false);

    next = removeMedia(next, missionId, 'b');
    assert.deepEqual(next.missions[0]!.media.map((ref) => ref.mediaId), ['a']);
  });

  test('a kind the schema does not know is reported at the file', () => {
    const { state, missionId } = line();
    const next = addMedia(state, missionId, { id: 'x', kind: 'hologram' as never, altText: null });
    const issues = issuesAt(issuesOfMission(next, missionId, TYPE), 'media');
    assert.deepEqual(issues.map((issue) => issue.path), ['media[0].kind']);
  });
});

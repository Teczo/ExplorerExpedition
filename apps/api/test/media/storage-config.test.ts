/**
 * Reading the storage settings (EXPD-021).
 *
 * None at all is allowed: the media routes answer 503. Half of them is not.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_URL_SECONDS,
  StorageConfigError,
  readStorageConfig,
} from '../../src/config/storage-config.ts';

const AZURE = {
  AZURE_STORAGE_ACCOUNT: 'stexpddev123',
  IDENTITY_ENDPOINT: 'http://127.0.0.1:41741/msi/token',
  IDENTITY_HEADER: 'header-secret',
};

test('no storage account means no storage, and no error', () => {
  assert.equal(readStorageConfig({}), undefined);
  assert.equal(readStorageConfig({ AZURE_STORAGE_ACCOUNT: '  ' }), undefined);
});

test('what EXPD-007 sets is read, with the defaults filled in', () => {
  assert.deepEqual(readStorageConfig(AZURE), {
    accountName: 'stexpddev123',
    blobEndpoint: 'https://stexpddev123.blob.core.windows.net/',
    mediaContainer: 'media',
    identityEndpoint: AZURE.IDENTITY_ENDPOINT,
    identityHeader: AZURE.IDENTITY_HEADER,
    uploadUrlSeconds: DEFAULT_URL_SECONDS.upload,
    downloadUrlSeconds: DEFAULT_URL_SECONDS.download,
  });
});

test('the endpoint, the container and both lifetimes can be set', () => {
  const config = readStorageConfig({
    ...AZURE,
    AZURE_STORAGE_BLOB_ENDPOINT: 'https://example.blob.core.windows.net/',
    AZURE_STORAGE_MEDIA_CONTAINER: 'evidence',
    MEDIA_UPLOAD_URL_SECONDS: '1800',
    MEDIA_DOWNLOAD_URL_SECONDS: '300',
  });
  assert.equal(config?.blobEndpoint, 'https://example.blob.core.windows.net/');
  assert.equal(config?.mediaContainer, 'evidence');
  assert.equal(config?.uploadUrlSeconds, 1800);
  assert.equal(config?.downloadUrlSeconds, 300);
});

test('an account with no identity to sign for it is refused', () => {
  assert.throws(
    () => readStorageConfig({ AZURE_STORAGE_ACCOUNT: 'stexpddev123' }),
    StorageConfigError,
  );
});

test('a lifetime that is not whole, not positive, or over an hour is refused', () => {
  for (const bad of ['0', '-5', '1.5', 'soon', '3601']) {
    assert.throws(
      () => readStorageConfig({ ...AZURE, MEDIA_UPLOAD_URL_SECONDS: bad }),
      StorageConfigError,
      bad,
    );
  }
});

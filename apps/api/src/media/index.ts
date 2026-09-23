/**
 * Signed media upload and download URLs (EXPD-021).
 *
 * A phone uploads straight to Blob Storage with a URL the API signed, and a
 * teacher reads the file back the same way. The bytes never pass through
 * the API.
 *
 * Where to look:
 *
 *   `blob-sas.ts`          Signing one blob's URL with a user delegation key.
 *   `delegation-key.ts`    Getting that key, with the app's managed identity.
 *   `media-storage.ts`     The two URLs the routes ask for, and how long each lasts.
 *   `media-service.ts`     The `media_asset` row an upload writes, and the checks
 *                          in front of a download.
 *   `routes.ts`            The endpoints, and the stack in front of them.
 */

export * from './blob-sas.ts';
export * from './delegation-key.ts';
export * from './media-storage.ts';
export * from './media-service.ts';
export * from './routes.ts';

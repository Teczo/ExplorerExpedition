/**
 * Signing a URL for one blob with a user delegation key (EXPD-021).
 *
 * A signed URL — a shared access signature, or SAS — lets whoever holds it
 * do one thing to one blob until a set time, without an account and without
 * the API in the middle. The student's phone PUTs its photograph straight to
 * Blob Storage with one, and a teacher's browser GETs it back with another.
 *
 * The signature is an HMAC over a fixed list of fields, keyed with a *user
 * delegation key*: a key Blob Storage hands to an Azure AD identity, which
 * is the only kind of key there is here, because the account's own keys are
 * switched off (EXPD-007). `delegation-key.ts` is what asks for one.
 *
 * This is written out by hand on `node:crypto`, not taken from
 * `@azure/storage-blob`, because that is a dependency and no ticket has
 * added it. The format is Azure's and is fixed by `SAS_VERSION`: a service
 * that reads a different list of fields reads a different `sv`.
 *
 * https://learn.microsoft.com/rest/api/storageservices/create-user-delegation-sas
 */

import { createHmac } from 'node:crypto';

/**
 * The storage service version every signature and every request is made
 * against. It decides the list of fields in `stringToSign` below; changing
 * it means checking that list against Azure's page for the new version.
 */
export const SAS_VERSION = '2022-11-02';

/** A user delegation key, exactly as Blob Storage returned it. */
export interface UserDelegationKey {
  /** `SignedOid`: the object id of the identity the key was issued to. */
  readonly signedObjectId: string;
  /** `SignedTid`: that identity's tenant. */
  readonly signedTenantId: string;
  /** `SignedStart`, as the service wrote it. Signed as the same string. */
  readonly signedStart: string;
  /** `SignedExpiry`, likewise. No URL signed with it outlives this. */
  readonly signedExpiry: string;
  /** `SignedService`: always `b`, for blob. */
  readonly signedService: string;
  /** `SignedVersion`. */
  readonly signedVersion: string;
  /** `Value`: the key itself, base64. */
  readonly value: string;
}

/**
 * What a URL lets its holder do.
 *
 * `c` is create: write a blob that does not exist yet, and nothing more. An
 * upload URL is `c` and not `w` on purpose, so that nobody holding it can
 * replace a photograph once a team has handed it in — and a phone that lost
 * signal part way through still has a good URL, because a blob upload either
 * lands whole or not at all. `r` is read.
 */
export type BlobPermission = 'c' | 'r';

/** Everything that goes into one signature. */
export interface BlobSasRequest {
  /** The storage account's name, such as `stexpddevabc123`. */
  readonly accountName: string;
  readonly containerName: string;
  /** The blob's path inside the container, unencoded. */
  readonly blobName: string;
  readonly permission: BlobPermission;
  readonly startsAt: Date;
  readonly expiresAt: Date;
  readonly key: UserDelegationKey;
}

/**
 * The fields signed, in the order Azure reads them for `SAS_VERSION`.
 *
 * Exported so that a test can hold it up against the documented order line
 * by line; nothing else should need it.
 */
export function stringToSign(request: BlobSasRequest): string {
  const { key } = request;
  return [
    request.permission, // sp
    isoSeconds(request.startsAt), // st
    isoSeconds(request.expiresAt), // se
    canonicalResource(request), // the blob, as /blob/account/container/name
    key.signedObjectId, // skoid
    key.signedTenantId, // sktid
    key.signedStart, // skt
    key.signedExpiry, // ske
    key.signedService, // sks
    key.signedVersion, // skv
    '', // saoid — no preauthorised agent
    '', // suoid — no unauthorised agent
    '', // scid — no correlation id
    '', // sip — any address: a phone on a school trip has no fixed one
    'https', // spr
    SAS_VERSION, // sv
    'b', // sr — one blob
    '', // snapshot time
    '', // ses — no encryption scope
    '', // rscc
    '', // rscd
    '', // rsce
    '', // rscl
    '', // rsct
  ].join('\n');
}

/** The signature over `stringToSign`, base64. */
export function signature(request: BlobSasRequest): string {
  return createHmac('sha256', Buffer.from(request.key.value, 'base64'))
    .update(stringToSign(request), 'utf8')
    .digest('base64');
}

/**
 * The query string a signed URL carries, without the leading `?`.
 *
 * Every field that went into the signature and is not empty is here, so
 * Blob Storage can rebuild the same string and check it.
 */
export function sasQuery(request: BlobSasRequest): string {
  const { key } = request;
  const query = new URLSearchParams({
    sv: SAS_VERSION,
    spr: 'https',
    st: isoSeconds(request.startsAt),
    se: isoSeconds(request.expiresAt),
    sr: 'b',
    sp: request.permission,
    skoid: key.signedObjectId,
    sktid: key.signedTenantId,
    skt: key.signedStart,
    ske: key.signedExpiry,
    sks: key.signedService,
    skv: key.signedVersion,
    sig: signature(request),
  });
  return query.toString();
}

/**
 * The whole signed URL for one blob.
 *
 * `blobEndpoint` is the account's endpoint as EXPD-007 hands it over, such as
 * `https://stexpddev....blob.core.windows.net/`. The container and each part
 * of the blob's path are percent-encoded in the URL, and signed unencoded.
 */
export function signedBlobUrl(blobEndpoint: string, request: BlobSasRequest): string {
  const base = blobEndpoint.endsWith('/') ? blobEndpoint : `${blobEndpoint}/`;
  const path = [request.containerName, ...request.blobName.split('/')]
    .map(encodeURIComponent)
    .join('/');
  return `${base}${path}?${sasQuery(request)}`;
}

/**
 * A time as Azure signs it: ISO 8601, UTC, to the second.
 *
 * `toISOString` gives milliseconds, and a signature over a string with them
 * does not match one the service rebuilds without them.
 */
export function isoSeconds(time: Date): string {
  return `${time.toISOString().slice(0, 19)}Z`;
}

function canonicalResource(request: BlobSasRequest): string {
  return `/blob/${request.accountName}/${request.containerName}/${request.blobName}`;
}

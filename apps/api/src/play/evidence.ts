/**
 * The photo a team hands in as evidence (EXPD-033).
 *
 * A photo evidence submission names a `media_asset` row by its id. The
 * mission type's behaviour is pure and cannot look that row up, so the API
 * checks it here, inside the submission's transaction:
 *
 *   - the file belongs to this organisation, which the tenant repository
 *     already makes true — another school's id is simply not found;
 *   - it is an image, and its upload has not failed or been deleted;
 *   - a student on this team uploaded it, so one team cannot hand in
 *     another team's photo;
 *   - it is not already evidence for another submission.
 *
 * Once the submission row is written, the file is tied to it
 * (`media_asset.submission_id`), which is what the review queue (EXPD-056)
 * reads to show a teacher the photo. The tie is made only where the file is
 * still free, so two submissions racing for one photo cannot both have it.
 *
 * A file whose upload is still `pending` is accepted. The phone uploads
 * straight to Blob Storage (EXPD-021) and nothing marks evidence `ready`
 * yet, so refusing `pending` would refuse every photo.
 */

import type { TenantRepository } from '../db/tenant-repository.ts';
import { ApiError } from '../http/errors.ts';
import type { MediaAssetRow } from '../repositories/rows.ts';

/** The columns of `media_asset` this file reads beyond the shared row. */
interface EvidenceRow extends MediaAssetRow {
  readonly submission_id: string | null;
}

/** A 409 carrying `invalid-evidence`, with the reason for a person. */
function refuseEvidence(message: string, detail: string): ApiError {
  return new ApiError('conflict', {
    message,
    detail,
    refusal: { code: 'invalid-evidence' },
  });
}

/**
 * Checks the file a submission names, before anything is written.
 *
 * Throws a 409 with `invalid-evidence` when the file cannot be this team's
 * evidence.
 */
export async function checkEvidence(
  tenant: TenantRepository,
  teamId: string,
  mediaId: string,
): Promise<void> {
  const row = await tenant.findById<EvidenceRow>('media_asset', mediaId);
  if (row === null || row.status === 'deleted') {
    throw refuseEvidence(
      'That photo could not be found. Upload it again.',
      `media ${mediaId} is not in this organisation, or was deleted`,
    );
  }
  if (row.status === 'failed') {
    throw refuseEvidence(
      'That photo did not upload. Upload it again.',
      `media ${mediaId} failed to upload`,
    );
  }
  if (row.kind !== 'image') {
    throw refuseEvidence(
      'This mission needs a photo.',
      `media ${mediaId} is ${row.kind}, not an image`,
    );
  }
  const onTeam =
    row.uploaded_by_participant !== null &&
    (await tenant.exists('team_member', {
      team_id: teamId,
      participant_id: row.uploaded_by_participant,
    }));
  if (!onTeam) {
    throw refuseEvidence(
      'That photo was not taken by your team.',
      `media ${mediaId} was not uploaded by a member of team ${teamId}`,
    );
  }
  if (row.submission_id !== null) {
    throw refuseEvidence(
      'That photo was already handed in. Take a new one.',
      `media ${mediaId} is already evidence for submission ${row.submission_id}`,
    );
  }
}

/**
 * Ties the file to the submission it is evidence for.
 *
 * Only a file that is still free is tied. When another submission took it
 * first, this throws and the transaction writes nothing.
 */
export async function attachEvidence(
  tenant: TenantRepository,
  mediaId: string,
  submissionId: string,
): Promise<void> {
  const tied = await tenant.update('media_asset', { id: mediaId, submission_id: null }, {
    submission_id: submissionId,
  });
  if (tied.length === 0) {
    throw refuseEvidence(
      'That photo was already handed in. Take a new one.',
      `media ${mediaId} was taken by another submission first`,
    );
  }
}

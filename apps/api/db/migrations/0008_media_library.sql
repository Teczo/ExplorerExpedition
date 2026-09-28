-- ---------------------------------------------------------------------------
-- 0008  The media library (EXPD-030)
-- ---------------------------------------------------------------------------
--
-- 0001 made `media_asset` for every file the platform stores, and EXPD-021
-- signs the URLs that put one there. Until now every row was a file a team
-- handed in, or about to. The library is the other kind: a picture, a sound,
-- a clip, a PDF or a 3D model an author uploads once and places on as many
-- missions, mission types and templates as they like.
--
-- Three things, and nothing else:
--
--   1. **`model` in `media_kind`.** A 3D model: `.glb`, `.gltf` or `.usdz`,
--      sent as `model/…`. The AR asset table (`ar_asset.media_asset_id`)
--      points at the file the same way anything else does.
--   2. **`in_library`.** Whether the row is one of the library's. It is a
--      column rather than "no submission yet", because a photograph a phone
--      has asked to upload but not yet handed in has no submission either,
--      and it must never show up in an author's list.
--   3. **`name`.** What the library shows the file as. A library file is
--      picked by a person, so it needs a name a person can read. Evidence
--      has none.
--
-- The library belongs to one organisation, like every other row here. A
-- file shared by every organisation would need a row with no organisation,
-- and `organisation_id` is `NOT NULL` on purpose (EXPD-004).
--
-- `ALTER TYPE … ADD VALUE` may run inside a transaction from PostgreSQL 12,
-- as long as nothing in the same transaction uses the new value. Nothing
-- here does.

BEGIN;

ALTER TYPE media_kind ADD VALUE IF NOT EXISTS 'model';

ALTER TABLE media_asset
  ADD COLUMN in_library boolean NOT NULL DEFAULT false,
  ADD COLUMN name text,
  ADD CONSTRAINT media_asset_library_has_name
    CHECK (NOT in_library OR length(btrim(coalesce(name, ''))) > 0),
  -- A library file is an author's, never a team's evidence.
  ADD CONSTRAINT media_asset_library_is_not_evidence
    CHECK (NOT in_library OR (submission_id IS NULL AND uploaded_by_participant IS NULL));

-- The library screen lists one organisation's files, newest first.
CREATE INDEX media_asset_library_idx
  ON media_asset (organisation_id, created_at DESC)
  WHERE in_library;

COMMIT;

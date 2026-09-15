-- EXPD-004 — Auth and organisation tenancy.
--
-- EXPD-003 left two holes on purpose. `app_user` has no password column, and
-- nothing says who is allowed to act for the platform rather than for one
-- organisation. This migration fills both, and adds the tables a sign-in
-- needs to survive a restart.
--
-- What it adds:
--
--   `app_user.is_platform_admin`  the platform-wide grant. Nothing else in
--                                 the schema crosses the tenant boundary.
--   `user_credential`             one password per account, hashed.
--   `auth_session`                one sign-in, and the refresh token that
--                                 keeps it alive.
--   `participant_device`          how a student's phone proves it is the
--                                 same phone, without an account.
--
-- What it does not add. Roles already exist: `membership.role` says what one
-- person may do inside one organisation, and EXPD-004 maps those values onto
-- the role names the platform uses. No enum value is added here, because the
-- five the schema already has cover the five roles the ticket names.
--
-- Isolation is not enforced here either. Every organisation-owned table
-- already carries `organisation_id`; the repository layer puts that column in
-- the WHERE clause of every statement it builds. EXPD-005 tests that it does.
--
-- Requires PostgreSQL 14 or newer.

BEGIN;

-- ---------------------------------------------------------------------------
-- Enum types
-- ---------------------------------------------------------------------------

-- Why a sign-in or a device stopped being usable. Kept as an enum rather than
-- free text because an operator reading the table has to be able to tell a
-- normal sign-out from a stolen token.
CREATE TYPE auth_revocation_reason AS ENUM (
  -- The person signed out.
  'logout',
  -- The refresh token was exchanged for a new one. Normal, and the common case.
  'rotated',
  -- A refresh token that had already been exchanged was presented again. That
  -- means two holders, so the whole family is revoked.
  'reuse-detected',
  -- The password changed, so every older sign-in is dropped.
  'password-changed',
  -- The membership that the sign-in was acting under was revoked.
  'membership-revoked',
  -- An administrator ended it.
  'admin'
);

-- ---------------------------------------------------------------------------
-- The platform-wide grant
-- ---------------------------------------------------------------------------

-- True for the handful of accounts that support the platform itself. A
-- platform admin is the only principal that may read across organisations,
-- and the repository layer makes it say so explicitly every time it does.
--
-- It is a column on `app_user` and not a `membership` role on purpose: the
-- grant belongs to no organisation, so there is no organisation to hang it
-- off. EXPD-070 builds the screen that sets it, and EXPD-006 logs the change.
ALTER TABLE app_user
  ADD COLUMN is_platform_admin boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN app_user.is_platform_admin IS
  'Platform support account. The only grant that crosses the tenant boundary.';

-- Platform admins are rare, so the index only holds the rows that are true.
CREATE INDEX app_user_platform_admin_idx
  ON app_user (id)
  WHERE is_platform_admin;

-- ---------------------------------------------------------------------------
-- Passwords
-- ---------------------------------------------------------------------------

-- One password per account, and nothing else.
--
-- It is its own table rather than columns on `app_user` for two reasons. A
-- query that draws a list of staff never has a reason to read a password
-- hash, and an account that signs in another way — EXPD-024 may add one —
-- simply has no row here.
--
-- `password_hash` holds the whole verifier, parameters included, so that the
-- cost can be raised later without a migration and without locking out anyone
-- whose row still carries the old cost. The format is written by
-- `apps/api/src/auth/password.ts`.
CREATE TABLE user_credential (
  user_id              uuid PRIMARY KEY REFERENCES app_user (id) ON DELETE CASCADE,
  -- The encoded verifier: algorithm, parameters, salt and derived key.
  password_hash        text NOT NULL CHECK (length(password_hash) > 0),
  -- When the password was last set. Every sign-in older than this is dead,
  -- which is how a password change signs the other phones out.
  password_changed_at  timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE user_credential IS
  'One hashed password per account. Absent for an account that signs in another way.';

COMMENT ON COLUMN user_credential.password_hash IS
  'Encoded verifier including its cost parameters, so the cost can be raised per row.';

-- ---------------------------------------------------------------------------
-- Sign-ins
-- ---------------------------------------------------------------------------

-- One sign-in on one device, and the refresh token that keeps it alive.
--
-- A sign-in belongs to a person, not to an organisation. Somebody who works
-- for two schools signs in once and then asks for an access token for
-- whichever organisation they are looking at, so there is no
-- `organisation_id` on this table. The access token carries the organisation;
-- this row only says the person is still who they said they were.
--
-- Only the hash of the refresh token is stored. The token itself is random,
-- so the hash needs no salt and no cost: an attacker who reads this table
-- gets nothing they can present.
--
-- `family_id` ties together every token that descends from one sign-in.
-- Refreshing rotates the token: the old row is marked `rotated` and a new row
-- joins the same family. If a rotated token is ever presented again, two
-- people hold it, and every row in the family is revoked at once.
CREATE TABLE auth_session (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  -- Shared by every rotation descending from the same sign-in.
  family_id           uuid NOT NULL,
  -- SHA-256 of the refresh token, hex encoded.
  refresh_token_hash  text NOT NULL,
  issued_at           timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  -- Set when this token was exchanged for the next one in the family.
  rotated_at          timestamptz,
  revoked_at          timestamptz,
  revoked_reason      auth_revocation_reason,
  -- Where the sign-in came from, so a person can recognise their own devices.
  user_agent          text,
  ip_address          inet,
  last_used_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_session_expires_after_issue
    CHECK (expires_at > issued_at),
  CONSTRAINT auth_session_revoked_has_reason
    CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);

CREATE UNIQUE INDEX auth_session_refresh_token_hash_key
  ON auth_session (refresh_token_hash);

-- Listing somebody's live sign-ins, newest first.
CREATE INDEX auth_session_user_id_idx
  ON auth_session (user_id, issued_at DESC);

-- Revoking a whole family is one statement against this index.
CREATE INDEX auth_session_family_id_idx ON auth_session (family_id);

-- Sweeping expired rows (EXPD-016 schedules it) reads only the live ones.
CREATE INDEX auth_session_live_expires_at_idx
  ON auth_session (expires_at)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE auth_session IS
  'One sign-in. Belongs to a person, not an organisation: the access token carries the organisation.';

COMMENT ON COLUMN auth_session.family_id IS
  'Every rotation of one sign-in shares this. Reuse of a rotated token revokes the family.';

-- ---------------------------------------------------------------------------
-- Student devices
-- ---------------------------------------------------------------------------

-- How a student's phone proves it is the same phone, across an app restart
-- and a dropped connection.
--
-- A student is a `participant`, not an `app_user`: there is no email and no
-- password (EXPD-071). The phone holds a random token issued when it joined,
-- and this row is what that token is checked against.
--
-- The row is tenant scoped, like everything a participant owns. It carries
-- `organisation_id` even though it could be reached through `participant`,
-- for the reason EXPD-003 gives: an isolation check should be one predicate
-- on the table being read.
--
-- Handing the token out at the moment of joining is EXPD-018, which owns join
-- codes. EXPD-004 owns only the issuing and the checking.
CREATE TABLE participant_device (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id        uuid NOT NULL REFERENCES organisation (id) ON DELETE CASCADE,
  participant_id         uuid NOT NULL REFERENCES participant (id) ON DELETE CASCADE,
  -- Denormalised from `participant`, so a run's devices are one query.
  expedition_session_id  uuid NOT NULL REFERENCES expedition_session (id) ON DELETE CASCADE,
  -- Matches `participant.device_id`. Identifies a phone, never a person.
  device_id              text NOT NULL CHECK (length(btrim(device_id)) > 0),
  -- SHA-256 of the device token, hex encoded.
  device_token_hash      text NOT NULL,
  issued_at              timestamptz NOT NULL DEFAULT now(),
  expires_at             timestamptz NOT NULL,
  last_seen_at           timestamptz,
  revoked_at             timestamptz,
  revoked_reason         auth_revocation_reason,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT participant_device_expires_after_issue
    CHECK (expires_at > issued_at),
  CONSTRAINT participant_device_revoked_has_reason
    CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);

CREATE UNIQUE INDEX participant_device_token_hash_key
  ON participant_device (device_token_hash);

-- One live token per phone per participant. Joining again from the same phone
-- replaces the old token rather than adding a second one.
CREATE UNIQUE INDEX participant_device_live_device_idx
  ON participant_device (participant_id, device_id)
  WHERE revoked_at IS NULL;

CREATE INDEX participant_device_organisation_id_idx
  ON participant_device (organisation_id);
CREATE INDEX participant_device_expedition_session_id_idx
  ON participant_device (expedition_session_id);

COMMENT ON TABLE participant_device IS
  'A student phone''s credential. Tenant scoped, like everything a participant owns.';

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------

CREATE TRIGGER user_credential_set_updated_at
  BEFORE UPDATE ON user_credential
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER auth_session_set_updated_at
  BEFORE UPDATE ON auth_session
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER participant_device_set_updated_at
  BEFORE UPDATE ON participant_device
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;

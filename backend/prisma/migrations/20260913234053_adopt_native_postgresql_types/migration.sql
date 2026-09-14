-- Stage 2: native PostgreSQL types (ticket 15). Hand-written and hand-reviewed
-- per ADR-0027's unsupported-feature workflow: PostgreSQL has no automatic
-- text→timestamptz, text→jsonb, integer→boolean, or text→enum cast, so every
-- column moves in place with an explicit USING cast and existing rows survive.
-- Only the superseded legacy CHECK constraints are dropped. The four email
-- normalization CHECKs from the baseline remain and are deliberately not
-- touched here.

-- CreateEnum
CREATE TYPE "AdministratorRole" AS ENUM ('owner', 'member');

-- CreateEnum
CREATE TYPE "IdentityTokenKind" AS ENUM ('email_verification', 'password_reset');

-- CreateEnum
CREATE TYPE "ApplicationType" AS ENUM ('web', 'spa');

-- CreateEnum
CREATE TYPE "OrganizationSettingKey" AS ENUM ('branding', 'password_policy', 'session_policy');

-- Drop the Stage 1 storage-shape guards: each is superseded by the native type
-- replacing it, and PostgreSQL would otherwise re-validate the old expression
-- against the new column type (and, for `email_verified`, its integer default
-- could not be cast). The email normalization CHECKs are untouched.
ALTER TABLE "identities" DROP CONSTRAINT "identities_email_verified_check";
ALTER TABLE "memberships" DROP CONSTRAINT "memberships_role_check";
ALTER TABLE "identity_tokens" DROP CONSTRAINT "identity_tokens_kind_check";
ALTER TABLE "administrator_invitations" DROP CONSTRAINT "administrator_invitations_role_check";
ALTER TABLE "applications" DROP CONSTRAINT "applications_type_check";
ALTER TABLE "organization_settings" DROP CONSTRAINT "organization_settings_key_check";

-- Timestamps: stored values are UTC ISO-8601 strings from `toISOString()`, so
-- the cast is exact; TIMESTAMPTZ(3) preserves the millisecond precision the
-- HTTP surface exposed before.
ALTER TABLE "organizations" ALTER COLUMN "created_at" TYPE TIMESTAMPTZ(3) USING "created_at"::timestamptz;
ALTER TABLE "administrators" ALTER COLUMN "created_at" TYPE TIMESTAMPTZ(3) USING "created_at"::timestamptz;
ALTER TABLE "admin_sessions" ALTER COLUMN "created_at" TYPE TIMESTAMPTZ(3) USING "created_at"::timestamptz,
                               ALTER COLUMN "expires_at" TYPE TIMESTAMPTZ(3) USING "expires_at"::timestamptz,
                               ALTER COLUMN "revoked_at" TYPE TIMESTAMPTZ(3) USING "revoked_at"::timestamptz;
ALTER TABLE "audit_events" ALTER COLUMN "occurred_at" TYPE TIMESTAMPTZ(3) USING "occurred_at"::timestamptz,
                           ALTER COLUMN "detail" TYPE JSONB USING "detail"::jsonb;
ALTER TABLE "identities" ALTER COLUMN "created_at" TYPE TIMESTAMPTZ(3) USING "created_at"::timestamptz,
                         ALTER COLUMN "sessions_revoked_at" TYPE TIMESTAMPTZ(3) USING "sessions_revoked_at"::timestamptz,
                         ALTER COLUMN "suspended_at" TYPE TIMESTAMPTZ(3) USING "suspended_at"::timestamptz,
                         ALTER COLUMN "anonymized_at" TYPE TIMESTAMPTZ(3) USING "anonymized_at"::timestamptz;
ALTER TABLE "identity_tokens" ALTER COLUMN "expires_at" TYPE TIMESTAMPTZ(3) USING "expires_at"::timestamptz,
                              ALTER COLUMN "consumed_at" TYPE TIMESTAMPTZ(3) USING "consumed_at"::timestamptz,
                              ALTER COLUMN "created_at" TYPE TIMESTAMPTZ(3) USING "created_at"::timestamptz;
ALTER TABLE "administrator_invitations" ALTER COLUMN "expires_at" TYPE TIMESTAMPTZ(3) USING "expires_at"::timestamptz,
                                        ALTER COLUMN "consumed_at" TYPE TIMESTAMPTZ(3) USING "consumed_at"::timestamptz,
                                        ALTER COLUMN "expiry_audited_at" TYPE TIMESTAMPTZ(3) USING "expiry_audited_at"::timestamptz,
                                        ALTER COLUMN "created_at" TYPE TIMESTAMPTZ(3) USING "created_at"::timestamptz;
ALTER TABLE "applications" ALTER COLUMN "created_at" TYPE TIMESTAMPTZ(3) USING "created_at"::timestamptz,
                           ALTER COLUMN "disabled_at" TYPE TIMESTAMPTZ(3) USING "disabled_at"::timestamptz,
                           ALTER COLUMN "deleted_at" TYPE TIMESTAMPTZ(3) USING "deleted_at"::timestamptz;
ALTER TABLE "client_secrets" ALTER COLUMN "created_at" TYPE TIMESTAMPTZ(3) USING "created_at"::timestamptz,
                             ALTER COLUMN "revoked_at" TYPE TIMESTAMPTZ(3) USING "revoked_at"::timestamptz;
ALTER TABLE "redirect_uris" ALTER COLUMN "created_at" TYPE TIMESTAMPTZ(3) USING "created_at"::timestamptz,
                            ALTER COLUMN "updated_at" TYPE TIMESTAMPTZ(3) USING "updated_at"::timestamptz;
ALTER TABLE "enrollments" ALTER COLUMN "created_at" TYPE TIMESTAMPTZ(3) USING "created_at"::timestamptz,
                          ALTER COLUMN "suspended_at" TYPE TIMESTAMPTZ(3) USING "suspended_at"::timestamptz;
ALTER TABLE "sessions" ALTER COLUMN "created_at" TYPE TIMESTAMPTZ(3) USING "created_at"::timestamptz,
                       ALTER COLUMN "last_seen_at" TYPE TIMESTAMPTZ(3) USING "last_seen_at"::timestamptz,
                       ALTER COLUMN "expires_at" TYPE TIMESTAMPTZ(3) USING "expires_at"::timestamptz,
                       ALTER COLUMN "revoked_at" TYPE TIMESTAMPTZ(3) USING "revoked_at"::timestamptz;
ALTER TABLE "authorization_codes" ALTER COLUMN "created_at" TYPE TIMESTAMPTZ(3) USING "created_at"::timestamptz,
                                   ALTER COLUMN "expires_at" TYPE TIMESTAMPTZ(3) USING "expires_at"::timestamptz,
                                   ALTER COLUMN "consumed_at" TYPE TIMESTAMPTZ(3) USING "consumed_at"::timestamptz;
ALTER TABLE "refresh_tokens" ALTER COLUMN "created_at" TYPE TIMESTAMPTZ(3) USING "created_at"::timestamptz,
                             ALTER COLUMN "expires_at" TYPE TIMESTAMPTZ(3) USING "expires_at"::timestamptz,
                             ALTER COLUMN "rotated_at" TYPE TIMESTAMPTZ(3) USING "rotated_at"::timestamptz,
                             ALTER COLUMN "revoked_at" TYPE TIMESTAMPTZ(3) USING "revoked_at"::timestamptz;
ALTER TABLE "organization_settings" ALTER COLUMN "updated_at" TYPE TIMESTAMPTZ(3) USING "updated_at"::timestamptz;
ALTER TABLE "email_change_requests" ALTER COLUMN "expires_at" TYPE TIMESTAMPTZ(3) USING "expires_at"::timestamptz,
                                    ALTER COLUMN "consumed_at" TYPE TIMESTAMPTZ(3) USING "consumed_at"::timestamptz,
                                    ALTER COLUMN "created_at" TYPE TIMESTAMPTZ(3) USING "created_at"::timestamptz;

-- Verification state: the legacy encoding was 0/1, so anything non-zero means
-- verified. The legacy integer default has to go before the type change (it
-- cannot be cast) and the boolean default is set in its place.
ALTER TABLE "identities" ALTER COLUMN "email_verified" DROP DEFAULT;
ALTER TABLE "identities" ALTER COLUMN "email_verified" TYPE BOOLEAN USING ("email_verified" <> 0);
ALTER TABLE "identities" ALTER COLUMN "email_verified" SET DEFAULT false;

-- Closed sets become enum types; the stored labels are exactly the old values.
ALTER TABLE "memberships" ALTER COLUMN "role" TYPE "AdministratorRole" USING "role"::"AdministratorRole";
ALTER TABLE "administrator_invitations" ALTER COLUMN "role" TYPE "AdministratorRole" USING "role"::"AdministratorRole";
ALTER TABLE "identity_tokens" ALTER COLUMN "kind" TYPE "IdentityTokenKind" USING "kind"::"IdentityTokenKind";
ALTER TABLE "applications" ALTER COLUMN "type" TYPE "ApplicationType" USING "type"::"ApplicationType";
ALTER TABLE "organization_settings" ALTER COLUMN "key" TYPE "OrganizationSettingKey" USING "key"::"OrganizationSettingKey";

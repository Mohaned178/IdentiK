# 18: Organization settings — branding, password policy, session timeout

**What to build:** The Organization-scoped half of the settings boundary (ADR-0022). Owners edit, in the dashboard via the Management API, all audit-logged: branding (name, logo, colors) applied to the hosted authentication pages and Account Center; per-Organization password policy (length/complexity floors) enforced at sign-up and password change; session timeout policy (idle expiry — Sessions lapse after the Organization's configured idle window). Instance-scoped trust fabric (SMTP, signing keys) deliberately remains out-of-band deployment configuration and out of this ticket's reach — a dashboard actor can never touch it.

**Blocked by:** 03 (sign-up exists for policy enforcement), 11 (Sessions exist for timeout to act on).

**Status:** done

- [x] Owners can edit Organization branding; hosted pages and Account Center render it
- [x] Per-Organization password policy is enforced at sign-up and password change; weaker passwords are refused
- [x] Session timeout policy lapses idle Sessions; activity refreshes the window
- [x] All three settings are Owner-editable, Member-visible, and every change is an audit event
- [x] No Organization-scoped setting can reach instance-scoped trust fabric (SMTP, signing keys) — the boundary is enforced at the Management API
- [x] Black-box tests verify policy enforcement and branded rendering over HTTP only

## Comments

Implementation notes:

- New `backend/src/settings/` module. `OrganizationSettingsService` keeps three Organization-scoped sections — `branding`, `passwordPolicy`, `sessionPolicy` — in one `organization_settings` row per section per Organization (migration 11), each a JSON document merged over the deployed defaults. The three section names are the allowlist; a settings document with any other top-level (or nested) key is refused with a 400 before anything is written, so neither SMTP nor signing keys are addressable through the Management API. Storage carries `updated_by`/`updated_at`.
- Management API (ADR-0019): `GET /api/organization/settings` is Member-visible (any Administrator); `PUT /api/organization/settings` is Owner-only (`OwnerGuard`). A change to a section writes the row and one audit event (`organization.branding.updated`, `organization.password_policy.updated`, `organization.session_policy.updated`) attributed to the Administrator; an unchanged section writes nothing. Validation is total before any write, so a batch mixing a real edit with an instance-scoped key changes nothing.
- Defaults (the policy floors the spec left open): branding name = the Organization's name, `logoUrl` null, primary `#2563eb`, secondary `#1e40af`; password policy `minLength` 8 with complexity floors off; session idle window 30 days. `minLength` is bounded 8–128, `idleTimeoutMs` 1s–30 days, colors must be hex, `logoUrl` an absolute http(s) URL or null.
- Password policy is a credential gate: enforced in `IdentitiesService` at sign-up, at self-service change (`/api/account-center/password`), and at reset completion. A refusal is `400 { error: 'password_too_weak', code }`; sign-up refuses before creating the reservation, and reset validates the token without consuming it first so a weak password never burns the link. The default floors match the pre-existing `@MinLength(8)` DTOs, so no existing shape changed.
- Session timeout is idle expiry (ADR-0022): `sessions.expires_at` is the idle deadline (`last_seen_at + Organization window`), set at creation and refreshed by `SessionsService.touch` on every resolution (`resolve` for the SSO cookie, `resolveById` for token grants), so activity pushes the window out and an untouched Session lapses with no scheduler. The browser cookie's `maxAge` stays the deployment-level absolute cap (`IDENTIK_SESSION_TTL_MS`).
- Branding is rendered on every hosted page payload — sign-up, forgot-password, reset-password (`EndUsersController.pageInfo`), the hosted sign-in page (`SignInPage`), and the Account Center view — alongside the unchanged `organizationName`.
- Tests: `e2e/src/organization-settings.test.ts` (9 tests, HTTP only) covers defaults, Member-read/Owner-write, branded rendering across all hosted pages and the Account Center, the trust-fabric boundary (unknown top-level and nested keys, mixed batches), audit attribution, password-policy refusal at sign-up and password change (and the absence of a reservation behind a refusal), and idle expiry with activity refresh. Existing page-shape assertions were loosened from `toEqual` to `toMatchObject` for the added `branding` field. Full suite: 187 tests across 19 files.

# 15: Identity anonymization — deletion semantics

**What to build:** What "delete user" really means here (ADR-0007). Anonymizing an Identity destroys PII irreversibly — email, credentials, Sessions, Enrollments all revoked — while audit history survives against a pseudonymous shell ("deleted identity #4a91"), so the platform can still answer "who signed in from that IP last Tuesday?" The email becomes immediately reusable by a fresh, unlinked Identity that inherits nothing. The dashboard's confirmation UX states the irreversibility plainly. No recovery path exists, by design.

**Blocked by:** 13 (the revocation machinery exists; anonymization is the irreversible sibling of suspension).

**Status:** done

- [x] Anonymizing an Identity destroys its email, credentials, Sessions, and Enrollments irreversibly
- [x] Audit history referencing the Identity survives against a pseudonymous shell — events remain answerable
- [x] The anonymized email is immediately reusable by a fresh signup, creating a new unlinked Identity that inherits nothing (no sessions, no enrollments, no history)
- [x] The new Identity's audit trail starts clean; the old trail stays pseudonymously attributed
- [x] No code path can reverse or "restore" an anonymized Identity
- [x] The dashboard confirmation states irreversibility plainly before the action
- [x] Anonymization is an audit event (perpetrator + when; target recorded pseudonymously)
- [x] Black-box tests cover the full arc over HTTP only, including email reuse and audit survival

## Comments

Implementation notes:

- Endpoint: `POST /api/identities/:id/anonymize` (`identities.controller.ts`, `AdministratorGuard`; Members included, like the other state levers — ADR-0008). Unknown/foreign ids are 404s. The response is the pseudonymous shell's `IdentityDetail`.
- Confirmation: the request must carry `{ confirm: true }`; without it the API refuses with 400 and states plainly that anonymization is irreversible (destroys email, credentials, Sessions, Enrollments; no path restores it). The dashboard workspace was removed at `815bf37`, so this Management API contract is the faithful backend embodiment of "the confirmation states irreversibility before the action"; the SPA dialog that renders it is deferred with the dashboard.
- Schema: migration v9 adds `identities.anonymized_at`. `identityState` gains `anonymized` (terminal, highest precedence) and both the Identity and Enrollment views pass it. The Identity view returns the id-derived pseudonym `deleted identity #<first4>` in place of the destroyed email; `anonymizedPseudonym`/`anonymizedHandle` live together in `identity-state.ts`.
- `IdentitiesService.anonymize`: `anonymized_at IS NULL` is the race-free arbiter; one transaction marks the shell terminal (`email` → non-deliverable `deleted-<id>@anonymized.invalid`, `password_hash` → `DUMMY_PASSWORD_HASH` so verification timing is unchanged, `email_verified = 0`, `suspended_at = NULL`, `sessions_revoked_at` advanced), deletes Enrollments, identity tokens, and pending authorization codes, and re-attributes the surviving audit details to the pseudonym. The Session cascade (`revokeAllForIdentity`, reason `anonymization`) follows; the shell is already dead at every credential gate regardless. Idempotent: a second call rolls back without a duplicate event.
- Audit pseudonymization: `json_set(detail, '$.email', pseudonym)` scoped to events whose `$.email` is exactly the destroyed address and that either carry the `identityId` or are End-User lifecycle kinds (`identity.%` / `enrollment.%`). A flat string replace was rejected in review: it rewrote substring/case collisions and could touch an Administrator invitation. The durable link stays the `identityId`; the trail is answered through the Identity detail's `recentActivity` (ticket 12 deliberately keeps the `identityId` filter off the audit route).
- Irreversibility: `authenticate` refuses `anonymized_at`; `resetPassword`/`changePassword` return false; `verifyEmail`, `forcePasswordReset` (409), and `suspend` are guarded; `TokenService` and `SessionsService` liveness checks include `anonymized_at`. A pre-deletion reset token is destroyed with the identity tokens, so it cannot heal the shell.
- Email reuse: freeing `(organization_id, email)` lets the same address sign up as a brand-new Identity with a new id; it inherits no Sessions, Enrollments, or history, and its `recentActivity` references only its own `identityId`.
- Tests: `e2e/src/identity-anonymization.test.ts` (4 tests) is black-box over HTTP/email only — destruction and every refusal path (sign-in, SSO cookie, refresh, introspection, userinfo, stale reset token), audit survival and scrub, email reuse with a clean trail, irreversibility (unsuspend/force-reset/forgot-password), the confirmation contract, Member access, and 404s. Full suite: 167 tests across 16 files.
- Deferred: the dashboard confirmation dialog and any "deleted identity" management UI (frontend removed); Application anonymization/disable/delete (ticket 16, Owner-only) reuses the same pseudonymization idea at Application scope.

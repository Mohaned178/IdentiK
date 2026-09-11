# 13: Two-level suspension + revoke-all-Sessions with immediate propagation

**What to build:** The security levers (ADR-0006). Two distinct dashboard actions, both via the Management API: suspend from Application (Enrollment-level — the user loses one Application) and suspend Identity (Organization-wide). Either way revocation is immediate at the platform: the live Session dies within seconds and new authentication is blocked at the affected scope. Revoke-all-Sessions evicts every device in one action. Propagation to Applications is honest: the platform's Session is dead instantly; each Application loses the user as it validates tokens — observable via introspection/refusal of rotating refresh tokens — and access tokens die within one short TTL. Suspension is the only "this actor is done" decision; there is no other lockout (that anti-pattern arrives, rejected, in ticket 17's criteria). Both suspension levels are reversible; anonymization (ticket 15) is the irreversible one.

**Blocked by:** 11 (Sessions and their token lineage can be revoked and observed), 12 (the Identity/Application views where the levers live).

**Status:** done

- [x] Suspend from Application blocks new authentication through that Application only; other Applications unaffected
- [x] Suspend Identity blocks authentication Organization-wide for that Identity
- [x] Both suspensions kill the Identity's live platform Session(s) within seconds of the action
- [x] Descendant refresh tokens are revoked immediately: rotation attempts are refused
- [x] Access tokens die within one short TTL — honest propagation, observable via introspection
- [x] Revoke-all-Sessions evicts every device in one action
- [x] Suspended Identities are refused at sign-in (ticket 09's gate) and at token refresh
- [x] Suspensions are reversible via unsuspend at both levels
- [x] Suspension and revocation actions are audit events, visible in the unified surface
- [x] Black-box tests observe the cascade from outside over HTTP only: sign-in refusal, introspection verdicts, refresh rotation refusals

## Comments

Implementation notes:

- Endpoints (all Management API, `AdministratorGuard`; Members pull these levers — suspension is routine state management, not an Owner-only credential action): `POST /api/identities/:id/suspend`, `POST /api/identities/:id/unsuspend`, `POST /api/identities/:id/sessions/revoke-all`, `POST /api/applications/:id/enrollments/:identityId/suspend`, `POST /api/applications/:id/enrollments/:identityId/unsuspend`. Suspend/unsuspend return the updated Identity detail or Enrollment view; revoke-all returns `{ revoked }: number`. Every target is Organization-scoped, so unknown and foreign ids are 404s.
- Suspend Identity (`IdentitiesService.suspend`) sets `identities.suspended_at` and revokes every live platform Session through the new `SessionsService.revokeAllForIdentity`, which kills the session rows, cascades `refresh_tokens.revoked_at` for the whole lineage, emits one `session.revoked` per device plus one `identity.sessions.revoked` aggregate, and is idempotent. Re-suspending is a true no-op (no cascade, no duplicate audit).
- Suspend from Application (`EnrollmentsService.suspendForApplication`) flips that Enrollment's `suspended_at` and walks the same session cascade: a platform Session is Organization-scoped (ADR-0013), so per ADR-0006 the live device dies even though only one Application is being taken away. The Identity's other Enrollments are untouched, and authentication through them is unaffected. Enrollment views and the Identity detail already surfaced the flag since ticket 12; no migration was needed — the columns landed in migration v7.
- Unsuspend never resurrects Sessions: `unsuspend` clears `suspended_at` and advances `identities.sessions_revoked_at`, so any Session created before or during suspension stays dead through the existing watermark gate. The Identity signs in again.
- Token-boundary gates: `TokenService.exchangeCode`, `rotateRefresh`, and refresh introspection now ask `EnrollmentsService.allows(...)` — a suspended Enrollment refuses issuance/rotation/introspection even if a Session somehow outlived the cascade, mirroring the existing identity-liveness re-checks. Suspended Identities were already refused at sign-in (`authenticate`), refresh (`isLive`), userinfo, and access-token introspection.
- Honest propagation: refresh tokens die immediately by revocation; access tokens stay untracked signed JWTs and die within their short TTL. Identity suspension flips access-token introspection at ask-time; Enrollment suspension leaves the bearer credential valid until expiry, which the black-box test observes with a 2-second TTL.
- Audit kinds: `identity.suspended` / `identity.unsuspended` (detail carries `identityId` + email so the Identity detail's recent activity links them), `enrollment.suspended` / `enrollment.unsuspended` (`identityId` + `applicationId` + email), `session.revoked` per device with `reason: 'suspension' | 'administrator'`, and `identity.sessions.revoked` with `{ identityId, count, reason }`. Admin actions are attributed to the Administrator id, which the audit surface resolves to name/email.
- Tests: `e2e/src/suspension-revocation.test.ts` (5 tests) is black-box over HTTP only — sign-in refusal, SSO-cookie death, refresh `invalid_grant`, introspection verdicts, TTL expiry, audit events, both reversals, no-resurrection after unsuspend, Member access, and 404s. Full suite: 157 tests across 14 files.
- Deferred: no dashboard UI exists (frontend removed at 815bf37); the levers are the Management API itself. Application disable/delete (ticket 16) reuses the token-boundary idea at Application scope, and anonymization (ticket 15) is the irreversible lever that will also walk the session cascade.

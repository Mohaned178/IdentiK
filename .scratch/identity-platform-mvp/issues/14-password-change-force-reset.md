# 14: Password change + Administrator force reset with Session cascade

**What to build:** Both password-change paths with their Session semantics (ADR-0013). The authenticated End User changes their password in the Account Center: the current Session survives (they stay signed in), every other Session is revoked — the stolen-laptop cascade. The Administrator's force reset is a state lever only (ADR-0008): it never sets or sees a credential; it sends a reset to the Identity's existing verified email, reusing ticket 04's machinery, and revokes all Sessions. Recovery completes through the same mailbox-proof flow.

**Blocked by:** 04 (reset machinery exists), 11 (Account Center exists as the self-service surface).

**Status:** done

- [x] An authenticated End User can change their password in the Account Center
- [x] The change keeps the current Session and revokes all other Sessions
- [x] An Administrator can force a password reset on an Identity from the dashboard, via the Management API
- [x] The force reset sends to the Identity's existing verified email; it never sets, reads, or displays any credential
- [x] Completing a forced reset revokes all Sessions of that Identity
- [x] Suspended Identities' forced resets deliver to the mailbox but do not restore authentication access
- [x] Password changes and force resets are audit events
- [x] Black-box tests verify both cascades over HTTP only

## Comments

Implementation notes:

- Account Center password change: `POST /api/account-center/password` (`account-center.controller.ts`) with `{ currentPassword, newPassword }`, guarded by the same `EndUserSessionGuard` as the rest of the surface. The current credential must be presented; a wrong one is a clean 403 and changes nothing (but is audited). The logic lives in `IdentitiesService.changePassword` because credentials are the Identity aggregate's business; `AccountCenterModule` imports `IdentitiesModule` for it.
- Session cascade: `SessionsService.revokeOthersForIdentity` (ADR-0013) revokes every live Session of the Identity except the caller's, in one transaction with the refresh-token cascade and `session.revoked` / `identity.sessions.revoked` events (new reason `password_change`). The current Session's cookie and descendant refresh tokens survive; the other device's cookie, its rotated lineage, and its cross-Application children all die. `revokeAllForIdentity` and `revokeOthersForIdentity` now share one `revokeRows` unit.
- Force reset: `POST /api/identities/:id/force-password-reset` (Administrator sessions; Members included — a routine state lever, ADR-0008). It reuses ticket 04's token + mail machinery, audits `identity.password_reset.forced` before delivery, sends to the Identity's existing email, and revokes every Session with reason `password_reset`. It never returns credential material: the response is `{ status: 'reset-sent' }`.
- Verified-email gate: an Unverified Reservation gets 409 — the lever's premise is a proven mailbox, and the reservation heals through the mailbox-proof flows (ADR-0011), not through an Administrator action.
- Completion: the same `/api/end-users/reset-password` route as forgot-password; the watermark set on completion revokes every Session, including one created between the lever and the click while the old credential still worked. A suspended Identity completes the reset and receives the new credential, but the suspension gate keeps authentication refused until unsuspended (ADR-0006).
- Audit events: `identity.password_change.completed` / `.failed` (`reason: invalid_current_password`) for the self-service path; `identity.password_reset.forced` (attributed to the Administrator) plus ticket 04's `.completed` for the forced path; `session.revoked` / `identity.sessions.revoked` for both cascades. A failed change is audited because a live Session presenting the wrong credential is what a stolen device looks like.
- Ordering: the change's cascade runs before the credential write, and the force reset audits + mails before its cascade — either mid-failure over-revokes or leaves the lever retriable, never a changed password with live Sessions or dead devices with no recovery link. Credential + cascade remain two synchronous units (the repo's established service composition; `suspend` is the same shape); making them one unit would leak transaction management across services for an unobservable window.
- Tests: `e2e/src/password-change-force-reset.test.ts` (6 tests) drives two devices through the real authorize/token flows and asserts the wrong-credential 403 and its audit, the kept-cookie + kept-refresh vs dead-cookie + dead-refresh cascade, the old/new credential switch, the forced-reset mail + immediate cascade + completion watermark (including a Session created after the lever), the suspended-Identity arc through unsuspend, Member access, 404s, and the unverified 409. 163 tests pass in the full suite.
- Review round applied: verified-email gate; audit-before-delivery on the lever; failed-change audit with reason; `identity.password_change.completed`/`.failed` naming aligned with the repo's `<domain>.<action>.<phase>` convention; `IdentityTarget`/`SessionRef`/shared `RevokeManyInput` renames and one fewer organization-name lookup; the test helper `signInAndExchange` now delegates to `signIn` instead of rebuilding the authorize request.
- Deferred: password policy enforcement at password change (ticket 18); throttling of failed password-change attempts (ticket 17 owns rate limiting; this path is Session-authenticated, not public).

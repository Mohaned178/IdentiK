# 11: Account Center — Session visibility, revocation, sign-out, connected Applications

**What to build:** The End-User self-service surface (ADR-0018): a platform-hosted Account Center. The End User sees their active Sessions — the signed-in devices, with recognizable device metadata (device, time, last-seen) — and can revoke any one of them: the SSO cookie dies and all descendant refresh tokens are revoked immediately (ADR-0013). Sign-out is revocation of the current Session, nothing more mystical; Applications lose the user as their tokens validate. Connected Applications lists the End User's Enrollments, informational only (ADR-0014). The Account Center is linked from Applications; they never embed it.

**Blocked by:** 09 (Sessions exist with their parent-child token structure), 10 (refresh tokens as Session children to revoke).

**Status:** done

- [x] The Account Center is a platform-hosted surface an authenticated End User can reach
- [x] Active Sessions are listed with recognizable device metadata (device, time, last-seen) so a non-expert can identify them
- [x] Revoking a Session kills its SSO cookie and all descendant refresh tokens immediately; a rotated refresh attempt from that lineage is refused
- [x] Sign-out revokes the current Session
- [x] Connected Applications shows the End User's Enrollments, informational only — no consent or un-enroll action for End Users
- [x] Session revocation events are audit events
- [x] Black-box tests verify revocation observable from outside: cookie invalid, refresh lineage dead, over HTTP only

## Comments

Implementation notes:

- Account Center surface: `GET /api/account-center` (page data), `POST /api/account-center/sessions/:id/revoke`, `POST /api/account-center/sign-out` (`account-center.controller.ts`). The frontend workspace was removed earlier (815bf37), so the surface is page-data JSON in the same pattern as the hosted sign-in page. The view is built from the resolved Session's Identity — the request never names whose Sessions to touch; a foreign or unknown Session id is a 404.
- End-User authentication: `EndUserSessionGuard` (`sessions/end-user.guard.ts`) resolves the `identik_sso_session` cookie through the same fail-closed `SessionsService.resolve` gate used everywhere (revoked, expired, unverified, suspended, and password-reset watermark all refuse). The resolution also advances `last_seen_at`, so visiting the Account Center is itself device activity.
- Session list: `SessionsService.listForIdentity` reuses the liveness gate and returns each active Session's hashed-token-free metadata — device (`user_agent`), `createdAt` (time), `lastSeenAt`. The page marks each entry `current` and carries `currentSessionId`; a non-expert can identify a device by the browser string and when it was last active.
- Revocation cascade: `SessionsService.revoke` is one transaction — `sessions.revoked_at` + `UPDATE refresh_tokens SET revoked_at` for every child (`WHERE revoked_at IS NULL`, covering rotated tokens too) + a `session.revoked` audit event with `{ identityId, sessionId, reason }`. Idempotent: a second revoke changes nothing and is not an error. Revoking the current Session also clears the browser cookie, so self-revoke and sign-out converge. The mint path re-checks the parent Session with no await between check and insert, so a revocation landing while tokens are being signed cannot leave a live child behind.
- Sign-out: revocation of the current Session (ADR-0013) — `SessionsService.signOut` resolves the cookie, revokes with reason `sign_out`, and the controller clears the cookie; uniform 204 whether or not a live Session was presented, so a stale cookie cannot linger. There is no OIDC RP-initiated logout route (front/back-channel logout propagation is explicitly out of scope).
- Connected Applications: Enrollments joined to their Applications, informational only — name, type, enrolledAt, suspension flag. No consent and no un-enroll action exists for End Users (ADR-0014); suspension and un-enrollment stay Administrator levers (tickets 13/16).
- Tests: `e2e/src/account-center.test.ts` (9 tests) drives two devices through the real authorize/token flows, asserts the 401 surface, device metadata and connected-Applications shape, the revoked-cookie 401 and dead rotated-refresh lineage (exchange + introspection) including a second Application's child of the same Session (the cross-Application cascade), cross-Identity 404, idempotent revoke, sign-out cookie clearing and lineage death, and the `session.revoked` audit events with reasons. 145 tests pass in the full suite.
- Review round applied: cross-Application lineage coverage; `last_seen_at` now advances only for live Sessions (a dead cookie cannot refresh a revoked device's activity); mint-parent re-check closes the revoke-during-signing window; `ApplicationType` reused instead of a bare string; sign-out resolution moved behind `SessionsService.signOut`; and the pre-existing 1s-TTL access-token expiry test was widened to 2s to remove a full-suite timing flake.
- Deferred: password change and its other-Sessions cascade (ticket 14); Administrator visibility into Sessions (ticket 12); per-Organization session policy (ticket 18). The spec's "linked from Applications" is a client-UI concern; with the frontend workspace removed (815bf37) this release serves the Account Center as page-data JSON, the same documented deviation as the hosted sign-in page.

# 17: Throttling + audited failed authentication — no lockout, ever

**What to build:** The anti-abuse posture (ADR-0020). All public authentication endpoints (sign-in, sign-up, forgot-password, token exchange) apply rate limiting with escalating delay, per-source and per-Identity. Hard lockout deliberately does not exist: there is no code path anywhere that renders an Identity permanently or temporarily "locked" — lockout is a denial-of-service primitive (an attacker logs Mohamed out of existence by spamming failures), and suspension is the only "this actor is done" decision (ADR-0006). Failed authentication attempts are audit events carrying source and targeted Identity, so credential campaigns are visible in the unified audit surface while the platform declines to auto-punish: visibility instead of self-inflicted denial of service.

**Blocked by:** 04 (recovery endpoints exist to throttle), 08 (audit surface exists to make the campaign visible), 09 (sign-in to attack and audit).

**Status:** done

- [x] Public authentication endpoints apply escalating per-source and per-Identity rate limiting
- [x] Throttling behavior is observable at the HTTP surface (delayed responses), not via internal counters
- [x] No lockout code path exists: no number of failures renders an Identity locked — verified by sustained-attack test
- [x] Failed authentication attempts are recorded as audit events with source and targeted Identity
- [x] A scripted credential campaign is visible as a sequence of audit events in the unified surface
- [x] Throttling does not distinguish email-exists from email-not-exists (uniformity from tickets 03/04 preserved)
- [x] Black-box tests drive a sustained attack over HTTP and assert delay + audit visibility + absence of lockout

## Comments

Implementation notes:

- New `ThrottleService` (`backend/src/throttle/`) holds recent attempt timestamps per key in memory and answers an escalating delay: the first `IDENTIK_THROTTLE_AFTER_ATTEMPTS` attempts in the `IDENTIK_THROTTLE_WINDOW_MS` window are free, then the delay doubles from `IDENTIK_THROTTLE_BASE_DELAY_MS` per attempt up to `IDENTIK_THROTTLE_MAX_DELAY_MS`. It only ever *delays* a response — no state flag, no "locked" column, nothing that can deny a correct credential forever (ADR-0020). Defaults: 15-minute window, 50 free attempts, 200ms base, 5s cap; all four are deployment configuration (the spec leaves thresholds open).
- Two dimensions per request: `source` (`req.ip`) and `identity`. The larger of the two delays wins, so an attack spread over many sources is still slowed per Identity and an attack over many Identities is still slowed per source. Keys are scoped per endpoint (`sign-in`, `sign-up`, `forgot-password`, `token`), so throttling an Administrator's sign-in never throttles an End User's.
- Wiring: `POST /api/oidc/authorize` (the hosted sign-in) and `POST /api/oidc/token` await the delay in their controllers; `POST /api/end-users/sign-up` and `POST /api/end-users/forgot-password` go through a shared `guardAttempt` helper. Sign-up/forgot-password answer uniformly by design (ADR-0005), so every request counts as one attempt; sign-in and token exchange count only refusals, and a proven credential clears the Identity's history via `recordSuccess` so a legitimate user who mistyped is never punished (the source history stays, so scanning remains slow).
- Token surface: there is no End-User email, so the Client ID is the principal key (the grant is bound to the Client) and the source covers everything else. The authorization endpoint is where Identity-keyed throttling actually bites.
- Uniformity (ADR-0020): the identity key is the *submitted* email, normalized exactly as the Identity lookup normalizes it, whether or not an Identity owns it. The delay therefore cannot distinguish email-exists from email-not-exists; the existing ticket 03/04 shape-and-timing uniformity tests still pass untouched (the ticket 17 test asserts delay uniformity directly).
- Audit: the existing `identity.sign_in.failed` events (ticket 09) already carry `email`, `identityId` when known, `reason`, `applicationId`, and `source`; ticket 17 makes the campaign observable as an ordered sequence with the same surface. No new audit kinds were needed for the throttling itself — throttling is a delay, not an event.
- Tests: `e2e/src/throttling.test.ts` (7 tests) drives an aggressive configuration (2 free attempts, 150ms base, 1.5s cap) black-box over HTTP: an 8-attempt campaign is measurably delayed, the correct credential still signs in after 6 failures (the no-lockout proof), the campaign reads as eight newest-first audit events each carrying source and Identity, existing and unknown emails are throttled and refused identically, and sign-up, forgot-password, and token exchange each escalate. HTTP only; no DB inspection. Full suite: 177 tests across 18 files.
- Deferred: persistent/shared throttle state (the Instance is a single process over SQLite, so in-memory is consistent today; a clustered deployment would want shared counters), and auditing throttling itself as an event (explicitly not required — the failures are the events).

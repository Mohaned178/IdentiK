# 17: Throttling + audited failed authentication — no lockout, ever

**What to build:** The anti-abuse posture (ADR-0020). All public authentication endpoints (sign-in, sign-up, forgot-password, token exchange) apply rate limiting with escalating delay, per-source and per-Identity. Hard lockout deliberately does not exist: there is no code path anywhere that renders an Identity permanently or temporarily "locked" — lockout is a denial-of-service primitive (an attacker logs Mohamed out of existence by spamming failures), and suspension is the only "this actor is done" decision (ADR-0006). Failed authentication attempts are audit events carrying source and targeted Identity, so credential campaigns are visible in the unified audit surface while the platform declines to auto-punish: visibility instead of self-inflicted denial of service.

**Blocked by:** 04 (recovery endpoints exist to throttle), 08 (audit surface exists to make the campaign visible), 09 (sign-in to attack and audit).

**Status:** ready-for-agent

- [ ] Public authentication endpoints apply escalating per-source and per-Identity rate limiting
- [ ] Throttling behavior is observable at the HTTP surface (delayed responses), not via internal counters
- [ ] No lockout code path exists: no number of failures renders an Identity locked — verified by sustained-attack test
- [ ] Failed authentication attempts are recorded as audit events with source and targeted Identity
- [ ] A scripted credential campaign is visible as a sequence of audit events in the unified surface
- [ ] Throttling does not distinguish email-exists from email-not-exists (uniformity from tickets 03/04 preserved)
- [ ] Black-box tests drive a sustained attack over HTTP and assert delay + audit visibility + absence of lockout

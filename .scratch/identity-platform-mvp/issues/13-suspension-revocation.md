# 13: Two-level suspension + revoke-all-Sessions with immediate propagation

**What to build:** The security levers (ADR-0006). Two distinct dashboard actions, both via the Management API: suspend from Application (Enrollment-level — the user loses one Application) and suspend Identity (Organization-wide). Either way revocation is immediate at the platform: the live Session dies within seconds and new authentication is blocked at the affected scope. Revoke-all-Sessions evicts every device in one action. Propagation to Applications is honest: the platform's Session is dead instantly; each Application loses the user as it validates tokens — observable via introspection/refusal of rotating refresh tokens — and access tokens die within one short TTL. Suspension is the only "this actor is done" decision; there is no other lockout (that anti-pattern arrives, rejected, in ticket 17's criteria). Both suspension levels are reversible; anonymization (ticket 15) is the irreversible one.

**Blocked by:** 11 (Sessions and their token lineage can be revoked and observed), 12 (the Identity/Application views where the levers live).

**Status:** ready-for-agent

- [ ] Suspend from Application blocks new authentication through that Application only; other Applications unaffected
- [ ] Suspend Identity blocks authentication Organization-wide for that Identity
- [ ] Both suspensions kill the Identity's live platform Session(s) within seconds of the action
- [ ] Descendant refresh tokens are revoked immediately: rotation attempts are refused
- [ ] Access tokens die within one short TTL — honest propagation, observable via introspection
- [ ] Revoke-all-Sessions evicts every device in one action
- [ ] Suspended Identities are refused at sign-in (ticket 09's gate) and at token refresh
- [ ] Suspensions are reversible via unsuspend at both levels
- [ ] Suspension and revocation actions are audit events, visible in the unified surface
- [ ] Black-box tests observe the cascade from outside over HTTP only: sign-in refusal, introspection verdicts, refresh rotation refusals

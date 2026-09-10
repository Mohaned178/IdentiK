# 14: Password change + Administrator force reset with Session cascade

**What to build:** Both password-change paths with their Session semantics (ADR-0013). The authenticated End User changes their password in the Account Center: the current Session survives (they stay signed in), every other Session is revoked — the stolen-laptop cascade. The Administrator's force reset is a state lever only (ADR-0008): it never sets or sees a credential; it sends a reset to the Identity's existing verified email, reusing ticket 04's machinery, and revokes all Sessions. Recovery completes through the same mailbox-proof flow.

**Blocked by:** 04 (reset machinery exists), 11 (Account Center exists as the self-service surface).

**Status:** ready-for-agent

- [ ] An authenticated End User can change their password in the Account Center
- [ ] The change keeps the current Session and revokes all other Sessions
- [ ] An Administrator can force a password reset on an Identity from the dashboard, via the Management API
- [ ] The force reset sends to the Identity's existing verified email; it never sets, reads, or displays any credential
- [ ] Completing a forced reset revokes all Sessions of that Identity
- [ ] Suspended Identities' forced resets deliver to the mailbox but do not restore authentication access
- [ ] Password changes and force resets are audit events
- [ ] Black-box tests verify both cascades over HTTP only

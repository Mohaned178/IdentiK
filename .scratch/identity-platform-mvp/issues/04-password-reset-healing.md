# 04: Forgot password, reset, and pre-claimed email healing

**What to build:** The End-User recovery flow. "Forgot password" responds uniformly (same shape, same timing, whether or not the email exists — nothing confirmed at the HTTP layer); where an Identity exists, a reset link lands in the mailbox. Clicking the link proves mailbox control — and per ADR-0011 any proof of mailbox control marks the email verified, so a reset on an Unverified Reservation heals it to verified in the same act. Setting the new password revokes all of the Identity's Sessions. The headline scenario (ADR-0005): an attacker pre-claims `victim@example.com`; the victim's sign-up is refused; the victim requests a reset; the link arrives in the victim's own inbox; the click hands the Identity to its true owner with the attacker's password gone — no Administrator intervention anywhere in the arc.

**Blocked by:** 03 (sign-up + verification gate exist; recovery composes with them).

**Status:** ready-for-agent

- [ ] The forgot-password request responds with identical shape and timing whether the email exists or not
- [ ] Where an Identity exists, a reset email is delivered via the outbound mail boundary (captured in tests)
- [ ] Reset links are single-use and expire
- [ ] Completing a reset sets the new password and revokes every Session of that Identity
- [ ] A reset on an Unverified Reservation also marks the email verified (mailbox proof is mailbox proof)
- [ ] The pre-claimed-email healing arc works end-to-end: refused sign-up → forgot-password → reset click → victim owns the Identity, attacker's credential dead
- [ ] Suspended Identities cannot use recovery to regain access
- [ ] Recovery initiation and completion are audit events
- [ ] Black-box tests cover the healing arc and the uniformity guarantee over HTTP only

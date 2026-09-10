# 04: Forgot password, reset, and pre-claimed email healing

**What to build:** The End-User recovery flow. "Forgot password" responds uniformly (same shape, same timing, whether or not the email exists — nothing confirmed at the HTTP layer); where an Identity exists, a reset link lands in the mailbox. Clicking the link proves mailbox control — and per ADR-0011 any proof of mailbox control marks the email verified, so a reset on an Unverified Reservation heals it to verified in the same act. Setting the new password revokes all of the Identity's Sessions. The headline scenario (ADR-0005): an attacker pre-claims `victim@example.com`; the victim's sign-up is refused; the victim requests a reset; the link arrives in the victim's own inbox; the click hands the Identity to its true owner with the attacker's password gone — no Administrator intervention anywhere in the arc.

**Blocked by:** 03 (sign-up + verification gate exist; recovery composes with them).

**Status:** done

- [x] The forgot-password request responds with identical shape and timing whether the email exists or not
- [x] Where an Identity exists, a reset email is delivered via the outbound mail boundary (captured in tests)
- [x] Reset links are single-use and expire
- [x] Completing a reset sets the new password and revokes every Session of that Identity
- [x] A reset on an Unverified Reservation also marks the email verified (mailbox proof is mailbox proof)
- [x] The pre-claimed-email healing arc works end-to-end: refused sign-up → forgot-password → reset click → victim owns the Identity, attacker's credential dead
- [x] Suspended Identities cannot use recovery to regain access
- [x] Recovery initiation and completion are audit events
- [x] Black-box tests cover the healing arc and the uniformity guarantee over HTTP only

## Comments

Implementation notes:

- Reset "revokes every Session" by advancing `identities.sessions_revoked_at` (migration v3). Sessions themselves land in ticket 09; any Session created at or before the watermark is revoked, so a reset can never be undone by a Session that predates it. ADR-0013.
- Suspended Identities are excluded from regaining access structurally: recovery only ever sets a credential, never reinstates access; the suspension gate arrives with the authentication boundary (ticket 09) and the levers (ticket 13). No `suspended_at` column was added here — ticket 13 owns it.
- "Attacker's credential dead" is observed black-box as: the reservation's activation is consumed by the owner's reset (the attacker's original verification link now reports invalid) plus the audited `identity.password_reset.completed`. Credential verification arrives with ticket 09's sign-in.
- Review round: the timing test now signs up its "known" addresses so the exists branch is actually exercised; every forgot-password request audits `identity.password_reset.requested` (including unknown emails), and token consume/peek plus TTL env parsing are shared helpers.


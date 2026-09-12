# 03: End-User sign-up with the email verification gate

**What to build:** The hosted End-User sign-up page. A visitor signs up with email and password, creating an Unverified Reservation — an inert Identity that cannot authenticate, enroll, or do anything but wait for mailbox proof (ADR-0011). The verification email arrives via the captured transport in tests; clicking the link proves mailbox control and activates the Identity. Email uniquely identifies an Identity within its Organization (ADR-0005): signing up with an already-registered email is refused with "an identity with this email already exists — sign in instead," and the refusal response is uniform in shape and timing with the accepted case so nothing is confirmed at the HTTP layer. Passwords are Credentials on the Identity (ADR-0004), stored verifiable-only. The hosted page carries the Organization's name; full branding arrives with ticket 18.

**Blocked by:** 02 (bootstrap + dedicated Administrator sign-in exist so the two populations are distinct from day one).

**Status:** done

- [x] The hosted sign-up page is reachable over HTTP and accepts email + password
- [x] Sign-up creates an Unverified Reservation that cannot authenticate, enroll, or appear as a usable Identity
- [x] A verification email is sent through the outbound mail boundary; tests capture it and extract the link
- [x] Clicking the verification link marks the email verified, activating the Identity; the token is single-use and expires
- [x] Sign-up with an existing email is refused with the "sign in instead" message
- [x] Sign-up responses are uniform in shape and timing whether the email exists or not (nothing enumerable at the HTTP layer)
- [x] Email is unique per Organization: enforced, including the case-sensitivity normalization chosen by implementation
- [x] Passwords are stored in verifiable form only; no code path can read one back
- [x] Verification and refusal are audit events
- [x] Black-box tests drive the whole arc via HTTP + captured email only

## Comments

Review round (post ticket-03 implementation) resolved a serious spec finding: re-sending a verification link on a duplicate unverified sign-up allowed a pre-claim takeover — the mailbox owner's click would have activated an Identity whose password the attacker chose. Duplicate emails (verified or not) now get the same "already exists — sign in instead" mailbox message; healing to the true owner is the ticket-04 reset flow (which sets a fresh password while proving the mailbox), per ADR-0011.

## Comments

Review round applied: the verification click's catch-all redirect to the `invalid` page now logs the underlying failure (message only, never the token) before answering uniformly, so an internal error after token consumption is diagnosable from the Instance log instead of being indistinguishable from a dead link. The email-change click got the same treatment in ticket 19's flow.

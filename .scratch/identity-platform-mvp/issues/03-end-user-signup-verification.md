# 03: End-User sign-up with the email verification gate

**What to build:** The hosted End-User sign-up page. A visitor signs up with email and password, creating an Unverified Reservation — an inert Identity that cannot authenticate, enroll, or do anything but wait for mailbox proof (ADR-0011). The verification email arrives via the captured transport in tests; clicking the link proves mailbox control and activates the Identity. Email uniquely identifies an Identity within its Organization (ADR-0005): signing up with an already-registered email is refused with "an identity with this email already exists — sign in instead," and the refusal response is uniform in shape and timing with the accepted case so nothing is confirmed at the HTTP layer. Passwords are Credentials on the Identity (ADR-0004), stored verifiable-only. The hosted page carries the Organization's name; full branding arrives with ticket 18.

**Blocked by:** 02 (bootstrap + dedicated Administrator sign-in exist so the two populations are distinct from day one).

**Status:** ready-for-agent

- [ ] The hosted sign-up page is reachable over HTTP and accepts email + password
- [ ] Sign-up creates an Unverified Reservation that cannot authenticate, enroll, or appear as a usable Identity
- [ ] A verification email is sent through the outbound mail boundary; tests capture it and extract the link
- [ ] Clicking the verification link marks the email verified, activating the Identity; the token is single-use and expires
- [ ] Sign-up with an existing email is refused with the "sign in instead" message
- [ ] Sign-up responses are uniform in shape and timing whether the email exists or not (nothing enumerable at the HTTP layer)
- [ ] Email is unique per Organization: enforced, including the case-sensitivity normalization chosen by implementation
- [ ] Passwords are stored in verifiable form only; no code path can read one back
- [ ] Verification and refusal are audit events
- [ ] Black-box tests drive the whole arc via HTTP + captured email only

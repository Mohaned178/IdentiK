# 09: Authorization endpoint — hosted sign-in, SSO Session, silent Enrollment, code issuance

**What to build:** The heart of the product: an Application redirects an End User to the platform's authorization endpoint, and the hosted sign-in page authenticates them. Authentication creates the Session — the durable record of one authentication, the signed-in device (ADR-0013) — with its SSO cookie, and when the End User already has a live Session it is recognized and reused without a password (the D5 SSO moment). On first authentication through an Application, the Enrollment is created silently — no consent screen (ADR-0014). A short-lived, single-use authorization code is issued and the End User is redirected back to the Application's registered redirect URI with code + state, validated against the exact-match rules from ticket 07. Suspended Identities and suspended Enrollments are blocked at this boundary. Failed attempts are visible to the audit store. This ticket delivers authorize-endpoint validation (client, redirect URI, state), the hosted sign-in page, Session creation and reuse, and silent Enrollment — the code is consumed by ticket 10.

**Blocked by:** 03 (verified Identities can authenticate), 06 (Applications with Client IDs exist to authorize), 07 (redirect URIs to validate against).

**Status:** ready-for-agent

- [ ] An authorization request with an unknown/invalid Client ID, unregistered redirect URI, or mismatched-scope shape is refused with the appropriate error — never a redirect to an unvalidated URI
- [ ] Redirect back to the Application happens only on exact match of scheme + host + port + path
- [ ] The hosted sign-in page authenticates a verified Identity with email + password
- [ ] Authentication creates a Session (device record) and sets the platform SSO cookie
- [ ] An End User with a live Session is signed in on a second Application's authorize request without re-entering a password
- [ ] First authentication through an Application silently creates the Enrollment — no consent screen
- [ ] The authorization code is single-use and short-lived; replay is refused
- [ ] Suspended Identities cannot authenticate; suspended Enrollments cannot authorize through the suspended Application
- [ ] Unverified reservations cannot authenticate (the gate from ticket 03 holds here)
- [ ] Failed authentication attempts are recorded with source and targeted Identity
- [ ] Black-box tests drive the whole arc over HTTP only, including the SSO-reuse and silent-Enrollment moments

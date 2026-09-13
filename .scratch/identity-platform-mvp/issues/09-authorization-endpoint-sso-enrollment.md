# 09: Authorization endpoint — hosted sign-in, SSO Session, silent Enrollment, code issuance

**What to build:** The heart of the product: an Application redirects an End User to the platform's authorization endpoint, and the hosted sign-in page authenticates them. Authentication creates the Session — the durable record of one authentication, the signed-in device (ADR-0013) — with its SSO cookie, and when the End User already has a live Session it is recognized and reused without a password (the D5 SSO moment). On first authentication through an Application, the Enrollment is created silently — no consent screen (ADR-0014). A short-lived, single-use authorization code is issued and the End User is redirected back to the Application's registered redirect URI with code + state, validated against the exact-match rules from ticket 07. Suspended Identities and suspended Enrollments are blocked at this boundary. Failed attempts are visible to the audit store. This ticket delivers authorize-endpoint validation (client, redirect URI, state), the hosted sign-in page, Session creation and reuse, and silent Enrollment — the code is consumed by ticket 10.

**Blocked by:** 03 (verified Identities can authenticate), 06 (Applications with Client IDs exist to authorize), 07 (redirect URIs to validate against).

**Status:** done

- [x] An authorization request with an unknown/invalid Client ID, unregistered redirect URI, or mismatched-scope shape is refused with the appropriate error — never a redirect to an unvalidated URI
- [x] Redirect back to the Application happens only on exact match of scheme + host + port + path
- [x] The hosted sign-in page authenticates a verified Identity with email + password
- [x] Authentication creates a Session (device record) and sets the platform SSO cookie
- [x] An End User with a live Session is signed in on a second Application's authorize request without re-entering a password
- [x] First authentication through an Application silently creates the Enrollment — no consent screen
- [x] The authorization code is single-use and short-lived; replay is refused
- [x] Suspended Identities cannot authenticate; suspended Enrollments cannot authorize through the suspended Application
- [x] Unverified reservations cannot authenticate (the gate from ticket 03 holds here)
- [x] Failed authentication attempts are recorded with source and targeted Identity
- [x] Black-box tests drive the whole arc over HTTP only, including the SSO-reuse and silent-Enrollment moments

## Comments

Implementation notes:

- Authorization endpoint: `GET /api/oidc/authorize` validates the request and either reuses a live Session (302 with code + echoed state) or serves the hosted sign-in page's data (JSON, the repo's page-data pattern since the UI workspace was removed at 815bf37); `POST /api/oidc/authorize` carries the same request in its query plus `{ email, password }` and is the form target. Validation order is the security property: Client ID and redirect URI are checked first, and while they fail the response is a 400 JSON error page with no `Location` ever. Only after the redirect URI is proven registered do protocol errors (`invalid_request`, `unsupported_response_type`, `invalid_scope`) travel back as redirects.
- Exact match: the request's `redirect_uri` is canonicalized with the same `canonicalRedirectUri` ticket 07 stores by, then compared to the Application's list — exact on scheme + host + port + path (and any query), never a prefix.
- Scopes: `openid` is required and only `openid`, `email`, `profile` are served; the validated set is stored on the code for ticket 10. Per-Application scope configuration (spec: scopes are integration configuration) is not modelled yet — the platform-wide supported set is the honest interim and an Application allowlist can land additively.
- PKCE: a public (SPA/Mobile) client must present `code_challenge` with `code_challenge_method=S256`; a confidential client may omit PKCE (its secret replaces it) but any challenge it presents must be a complete, valid S256 one. `plain` and an orphan method are refused.
- Session (migration v7): `sessions` (identity, organization, hashed SSO token, user-agent, created/last-seen/expires, revoked_at). The SSO cookie (`identik_sso_session`) is HttpOnly/SameSite=Lax/Secure-per-base-URL and carries the raw token once. `SessionsService.resolve` fails closed on revoked, expired, unverified, suspended Identity, and the `sessions_revoked_at` watermark (a Session created at or before a password reset is dead). A Session is reusable only within its own Organization. Session lifetime is an instance-wide default (`IDENTIK_SESSION_TTL_MS`, 30 days) until per-Organization policy arrives in ticket 18.
- Silent Enrollment (migration v7): `enrollments` unique on (identity, application), created on first successful authorization with an `enrollment.created` audit event (identity, application, email) and no consent screen; later authorizations reuse it. A suspended Enrollment refuses with `access_denied` and records `identity.authorization.refused`.
- Suspension gates: `identities.suspended_at` and `enrollments.suspended_at` columns and fail-closed checks are in place here; the Management API actions that set them and the revocation cascade are ticket 13, whose checklist explicitly tests "refused at sign-in (ticket 09's gate)".
- Authorization code: `authorization_codes` (migration v7) stores a hash, the Application, Identity, parent Session, redirect URI, scope, PKCE challenge/method, nonce, `created_at`, `expires_at` (60s default, env-overridable) and `consumed_at`. Single-use and short-lived by construction; the atomic consume and replay refusal are exercised by ticket 10's token exchange, where the code is actually presented.
- Authentication failure: uniform 401 `{ error: "invalid_credentials" }` for unknown email, wrong password, unverified reservation, and suspended Identity, with dummy-hash verification so timing does not reveal existence. Each failure audits `identity.sign_in.failed` with the normalized email, identity id when known, reason, application id, and request source.
- Tests: `e2e/src/authorization-endpoint.test.ts` (17 tests) covers the no-redirect refusals, canonical match, page data, error redirects, scope/PKCE shapes, tampered POST, uniform credential failures, audit assertions, the full sign-in arc (cookie + silent Enrollment + code), cross-Application SSO reuse with once-only enrollments, fresh codes, and optional state.
- Deferred: token/refresh issuance and code consumption (ticket 10); suspension actions and the revocation cascade (ticket 13); authenticated-throttling (ticket 17); per-Application scope configuration and per-Organization session policy (tickets 10/18).

# 10: Token issuance — code exchange + PKCE, signed JWTs, JWKS, discovery, userinfo, rotating refresh tokens

**What to build:** The token machinery completing the OIDC core (ADR-0015). The token endpoint exchanges the single-use authorization code for tokens: a confidential client authenticates with its Client Secret; a public client must present PKCE and never presents a secret. The ID token asserts who, when, email + verification state, and for which Application. The access token is a signed JWT with short (minutes) TTL, audience strictly the platform's endpoints (userinfo — never the client's resources), verifiable offline. Refresh tokens rotate on use and are children of the Session (ADR-0013). JWKS publishes the verification keys; discovery self-describes the endpoints; userinfo serves profile claims; revocation and introspection endpoints round out the surface. Tests verify tokens with a standard off-the-shelf OIDC client library acting as Zotac — the zero-SDK assertion, executable.

**Blocked by:** 09 (codes to exchange exist; the Session parents the refresh tokens).

**Status:** ready-for-agent

- [ ] Code exchange succeeds once per code; replay is refused
- [ ] A confidential client authenticates at the token endpoint with a currently-valid Client Secret (any of its concurrent secrets)
- [ ] A public client must present valid PKCE; no secret is ever accepted from or required of a public client
- [ ] Revoked or misused secrets fail exchange immediately
- [ ] The ID token carries identity, email + verification state, audience (the Application), and timestamps, verifiable offline
- [ ] The access token is a signed JWT with short TTL and audience limited to platform endpoints
- [ ] Refresh tokens rotate on use; a rotated (previously-used) refresh token no longer works
- [ ] Refresh tokens are children of the Session: they belong to the authentications that minted them
- [ ] JWKS serves the current verification keys; discovery self-describes all endpoints
- [ ] Userinfo serves claims for a valid access token; introspection and revocation endpoints behave to spec
- [ ] A stock OIDC client library completes the full code + PKCE flow against the Instance with zero proprietary code
- [ ] Black-box tests verify issued JWTs offline against JWKS over HTTP only

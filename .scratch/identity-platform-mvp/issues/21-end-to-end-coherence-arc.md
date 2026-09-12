# 21: End-to-end coherence arc — release verification

**What to build:** The spec's coherence demo as one executable black-box arc, with a stock off-the-shelf OIDC client library playing Zotac throughout (the zero-SDK promise, made executable one final time at full scale). The arc: Instance bootstraps → default Organization → Owner invites a Member (who sets their own password) → Zotac registered as a Web Application → Mohamed signs up, verifies via captured email, signs in to Zotac through the standard code + PKCE flow → the stock library verifies the JWT offline against JWKS → the Member suspends Mohamed → the cascade is observed (Session dead, refresh refused, access dies within one TTL) → Mohamed's Identity is anonymized → his email is immediately reusable by a fresh, unlinked signup. Every step observable only at the two seams. This ticket is the release gate: it stitches every prior ticket's arc into the single story the spec demands.

**Blocked by:** 01–20 (all of them — this is the capstone).

**Status:** done

- [x] The full arc runs green as one black-box test over HTTP + captured email only
- [x] A stock OIDC client library plays the client Application end to end with zero proprietary code
- [x] The suspension cascade is observed mid-arc (Session dead, rotation refused, introspection verdict flips, access expires within one TTL)
- [x] The anonymization + email-reuse leg runs inside the same arc, proving inheritance is empty
- [x] The audit surface tells the whole story afterward: every security-relevant action of the arc is present and attributable
- [x] No test in the arc inspects storage, token internals, or module structure

## Comments

Implementation notes:

- `e2e/src/coherence-arc.test.ts` is the release gate: a single black-box `it` runs the spec's coherence demo end to end — Bootstrap Ceremony (token read from the console, the harness's documented ceremony reveal) → Owner signs in and invites a Member who sets her own password → Zotac registered as a confidential Web Application with its exact redirect URI → Mohamed signs up and proves his mailbox from captured mail. Observation is only through Seam 1 (HTTP) and Seam 2 (captured email); nothing inspects storage, token internals, or module structure.
- Zotac is played end to end by `openid-client`, a stock off-the-shelf OIDC library, with zero proprietary client code: discovery, `buildAuthorizationUrl` (code + PKCE), `authorizationCodeGrant` (state + nonce checked, ID token signature verified against the discovered JWKS), `fetchUserInfo`, `refreshTokenGrant`, and `tokenIntrospection`. Only the hosted sign-in form POST is manual — that is the browser's role, not the client's.
- The suspension cascade is observed mid-arc after the Member pulls the lever: introspection flips `active: false` immediately, rotation — proven working a moment earlier — is refused `invalid_grant`, the SSO cookie no longer resolves, and the Session list is empty. Access tokens stay untracked by design: the bearer JWT still verifies offline against JWKS and then fails `EXP` (`ERR_JWT_EXPIRED`) within one short TTL (`IDENTIK_ACCESS_TOKEN_TTL_MS=4000`).
- The anonymization leg runs inside the same arc: the shell is pseudonymous with empty Enrollments and Sessions, and the freed address is immediately reusable by a fresh, unlinked Identity. Before its first authentication the reborn Identity owns no Enrollments, no Sessions, and no inherited history; it then authenticates through the library to a different subject and earns its own Session and Enrollment, while the old cookie and refresh lineage stay dead.
- The final leg reads the audit surface and asserts every event family of the story is present and attributable: `instance` bootstrap; Owner invitation issued, registration, first-secret generation, redirect URI added; Member invitation accepted, suspension, per-device `session.revoked` plus the `identity.sessions.revoked` aggregate, and anonymization; End-User reservation, verification, and enrollment for both the destroyed and reborn Identity. The destroyed trail survives only pseudonymously — no old-Identity event names the freed address.
- Full suite: 211 tests across 22 files (this arc adds the 22nd file).

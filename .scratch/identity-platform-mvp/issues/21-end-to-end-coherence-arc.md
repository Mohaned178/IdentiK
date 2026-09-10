# 21: End-to-end coherence arc — release verification

**What to build:** The spec's coherence demo as one executable black-box arc, with a stock off-the-shelf OIDC client library playing Zotac throughout (the zero-SDK promise, made executable one final time at full scale). The arc: Instance bootstraps → default Organization → Owner invites a Member (who sets their own password) → Zotac registered as a Web Application → Mohamed signs up, verifies via captured email, signs in to Zotac through the standard code + PKCE flow → the stock library verifies the JWT offline against JWKS → the Member suspends Mohamed → the cascade is observed (Session dead, refresh refused, access dies within one TTL) → Mohamed's Identity is anonymized → his email is immediately reusable by a fresh, unlinked signup. Every step observable only at the two seams. This ticket is the release gate: it stitches every prior ticket's arc into the single story the spec demands.

**Blocked by:** 01–20 (all of them — this is the capstone).

**Status:** ready-for-agent

- [ ] The full arc runs green as one black-box test over HTTP + captured email only
- [ ] A stock OIDC client library plays the client Application end to end with zero proprietary code
- [ ] The suspension cascade is observed mid-arc (Session dead, rotation refused, introspection verdict flips, access expires within one TTL)
- [ ] The anonymization + email-reuse leg runs inside the same arc, proving inheritance is empty
- [ ] The audit surface tells the whole story afterward: every security-relevant action of the arc is present and attributable
- [ ] No test in the arc inspects storage, token internals, or module structure

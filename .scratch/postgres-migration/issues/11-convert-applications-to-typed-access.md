# 11: Convert applications to typed access

**What to build:** Application registration, Client Secrets, redirect URIs, disable/enable, and deletion use typed models and queries, including typed relation reads. The audit-detail scrub during deletion remains parameterized raw SQL, annotated with why it cannot be expressed as a typed update.

**Blocked by:** 09 (Prisma client foundation)

**Status:** ready-for-agent

- [ ] The applications module uses typed models and queries except for the documented audit-detail scrub
- [ ] The raw scrub is parameterized and carries a comment naming it as a deliberate exception
- [ ] Redirect URI, secret issuance/revocation, and disable/delete semantics are unchanged
- [ ] `npm run verify` is green

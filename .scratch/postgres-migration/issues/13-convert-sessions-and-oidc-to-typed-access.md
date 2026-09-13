# 13: Convert sessions and OIDC to typed access

**What to build:** Session lifecycle and the authorization-code and refresh-token paths use typed models and queries. Single-use consumption and rotation remain compare-and-swap operations expressed as conditional updates whose returned rows or counts decide the winner; revocation cascades run as interactive transactions.

**Blocked by:** 09 (Prisma client foundation)

**Status:** ready-for-agent

- [ ] Sessions and the OIDC modules use typed models and queries; no raw SQL remains in them
- [ ] Compare-and-swap consumption and rotation decisions are unchanged
- [ ] Revocation cascades are transactional
- [ ] `npm run verify` is green

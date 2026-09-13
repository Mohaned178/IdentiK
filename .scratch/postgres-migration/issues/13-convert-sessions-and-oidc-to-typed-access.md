# 13: Convert sessions and OIDC to typed access

**What to build:** Session lifecycle and the authorization-code and refresh-token paths use typed models and queries. Single-use consumption and rotation remain compare-and-swap operations expressed as conditional updates whose returned rows or counts decide the winner; revocation cascades run as interactive transactions.

**Blocked by:** 09 (Prisma client foundation)

**Status:** done

- [x] Sessions and the OIDC modules use typed models and queries; no raw SQL remains in them
- [x] Compare-and-swap consumption and rotation decisions are unchanged
- [x] Revocation cascades are transactional
- [x] `npm run verify` is green

## Comments

- `sessions.service.ts` is typed end to end: creation, resolution by SSO
  token or id (the Identity gate fields ride along as an include), the
  Account Center list ordering, activity touch, and every revocation path.
  The cascades keep their shape: `revoke` and `revokeRows` still run the
  row + descendant refresh tokens + audit in one interactive transaction,
  and `revokeRefreshTokensForApplication` still takes the caller's handle
  (now `DataHandle`) so it composes into the Application transactions.
- `token.service.ts` reads the authorization code through a select that never
  fetches the stored hash and keeps consumption first with
  `consumedAt: null` as the CAS; refresh rotation keeps
  `rotatedAt: null, revokedAt: null` as its CAS, and a lost race revokes the
  Session's lineage with the single reuse-detection audit. Introspection and
  revocation keep client ownership and their guarded updates. The Identity
  read selects the liveness gate plus the claims it may emit and never a
  credential (ADR-0008).
- `authorize.service.ts` creates authorization codes typed; that was the
  OIDC module's last raw statement.
- Two deliberate non-changes, recorded because the migration is
  behavior-preserving: the refresh-mint check-then-insert gap that ticket 06
  flagged remains open (its comment now says closing it is a separate change,
  not a later ticket), and `revokeLineage`/`revoke` were single-statement
  paths with no transaction at HEAD, so none was added.
- Verification: `npm run verify` green (23 files, 221 tests), including token
  issuance and expiry, authorization endpoint, account center, suspension
  revocation, and idle-timeout settings.
- Review round applied: `findRow` renamed to `findWithIdentity`, typed
  payload aliases renamed to describe their shape (`CodeExchange`,
  `RefreshTokenWithSession`, `TokenIdentity`), stale raw-column comments
  updated, and the stale "belongs to the final data-access conversion"
  atomicity note corrected.

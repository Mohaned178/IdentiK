# 04: Convert applications to the async contract

**What to build:** Application registration (with its first Client Secret), secret generation and revocation, redirect URI configuration, and disable/enable/delete — including the audit-detail scrub during deletion — reach storage exclusively through the async contract. Behavior is unchanged; the Instance still runs on SQLite.

**Blocked by:** 02 (async data-access facade)

**Status:** done

- [x] The applications module uses only the async contract for storage; no synchronous statements remain
- [x] Every transaction in the module uses the contract's transaction
- [x] Exact-match redirect URI behavior, secret issuance, and disable/delete semantics are unchanged
- [x] The full end-to-end suite passes unchanged on SQLite

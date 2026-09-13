# 03: Convert audit, bootstrap, administrators, and invitations to the async contract

**What to build:** The audit write path, the Bootstrap Ceremony, administrator sign-in and sessions, and the invitation flow reach storage exclusively through the async contract — awaited calls, affected-row counts, and contract transactions. Behavior is unchanged; the Instance still runs on SQLite.

**Blocked by:** 02 (async data-access facade)

**Status:** ready-for-agent

- [ ] These modules use only the async contract for storage; no synchronous statements remain in them
- [ ] Every transaction in these modules uses the contract's transaction
- [ ] Invitation acceptance and the bootstrap claim keep their race arbitration semantics
- [ ] The full end-to-end suite passes unchanged on SQLite

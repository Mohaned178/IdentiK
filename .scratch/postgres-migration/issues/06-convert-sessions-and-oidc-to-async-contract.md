# 06: Convert sessions and OIDC to the async contract

**What to build:** Session creation, resolution, and revocation, plus authorization-code issuance/consumption and refresh-token rotation/revocation, reach storage exclusively through the async contract. Behavior is unchanged; the Instance still runs on SQLite.

**Blocked by:** 02 (async data-access facade)

**Status:** ready-for-agent

- [ ] Sessions and the OIDC modules use only the async contract for storage; no synchronous statements remain
- [ ] Every transaction in these modules uses the contract's transaction
- [ ] Single-use consumption and refresh rotation arbitration are unchanged
- [ ] The full end-to-end suite passes unchanged on SQLite

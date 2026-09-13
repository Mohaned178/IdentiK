# 05: Convert identities to the async contract

**What to build:** Identity reservation, mailbox-proof tokens, password change and reset, verified email change, suspension, and anonymization (including its audit-detail scrubs) reach storage exclusively through the async contract. Behavior is unchanged; the Instance still runs on SQLite.

**Blocked by:** 02 (async data-access facade)

**Status:** ready-for-agent

- [ ] The identities module uses only the async contract for storage; no synchronous statements remain
- [ ] Every transaction in the module uses the contract's transaction
- [ ] Race arbitration is unchanged: sign-up reservation, verified email change, and anonymization cascades
- [ ] The full end-to-end suite passes unchanged on SQLite

# 07: Convert the remaining modules to the async contract

**What to build:** Enrollments, organization settings, the Account Center, the identity directory, and the remaining organization reads reach storage exclusively through the async contract. After this ticket no synchronous storage call style remains anywhere, clearing the way for the engine swap.

**Blocked by:** 02 (async data-access facade)

**Status:** ready-for-agent

- [ ] No synchronous storage call style remains in the backend
- [ ] Every transaction in these modules uses the contract's transaction
- [ ] Settings upsert and enrollment semantics are unchanged
- [ ] The full end-to-end suite passes unchanged on SQLite

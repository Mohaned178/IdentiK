# 05: Convert identities to the async contract

**What to build:** Identity reservation, mailbox-proof tokens, password change and reset, verified email change, suspension, and anonymization (including its audit-detail scrubs) reach storage exclusively through the async contract. Behavior is unchanged; the Instance still runs on SQLite.

**Blocked by:** 02 (async data-access facade)

**Status:** done

- [x] The identities module uses only the async contract for storage; no synchronous statements remain
- [x] Every transaction in the module uses the contract's transaction
- [x] Race arbitration is unchanged: sign-up reservation, verified email change, and anonymization cascades
- [x] The full end-to-end suite passes unchanged on SQLite

## Comments

- Scope boundary: `identities.service.ts` (the credential, mailbox-proof, state, and
  anonymization paths) is fully converted. `identity-directory.service.ts`, the
  Management API's read projections, is the "identity directory" ticket 07 names and
  keeps the legacy synchronous surface until then; its callers already await wherever
  ticket 05 made a signature async.

# 10: Close the session and token concurrency edge cases

**Type:** grilling
**Status:** open
**Blocked by:** 01

## Question

Which known session, token, and identity races and protocol edge cases close before the bar, and which are documented-and-accepted?

Facts: refresh rotation already revokes the whole lineage on replay, audited as `refresh_token.reuse.detected` (`token.service.ts:291-294,355-371`), and code/token consumption uses compare-and-swap updates. The acknowledged open window is in `mint()`: the Session, Enrollment, and Application are re-checked after signing, but `await`s leave a gap where a revocation can land behind a freshly minted refresh token — the code comment says closing it needs an atomic conditional insert or row lock (`token.service.ts:425-443`). Sign-up reservation arbitration was explicitly hardened (`identities.service.ts:456-480`).

Settle: close the mint window or accept and document it; confirm authorization-code single-use/replay behavior; concurrent suspension or anonymization during mint and during Account Center flows; clock skew and TTL boundaries; and whether lazy expiry without a sweep is acceptable for Sessions and tokens (also in the map's fog with data lifecycle).

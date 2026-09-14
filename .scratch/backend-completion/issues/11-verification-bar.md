# 11: Set the verification bar for completion

**Type:** grilling
**Status:** open
**Blocked by:** 01

## Question

What evidence proves the backend completion bar is met?

Facts: repository testing is deliberately full-stack black-box at two seams — the instance HTTP surface and captured email — with no unit tests and no unit-test tier (MVP spec, Testing Decisions; postgres-migration spec reaffirms it). `npm run verify` = typecheck + build + the e2e suite (23 files); CI runs PostgreSQL 18 (`.github/workflows/ci.yml`).

Settle: for each required ticket's decision, what new black-box e2e coverage is demanded (config refusal, health/readiness, migration failure modes, proxy/forwarded headers, error envelope, throttle keying); whether any decision warrants a unit or integration tier — breaking the established pattern deliberately; the release-gate command the Dockerization effort may rely on; and what must be green for this map's Destination to count as reached. Depends on the completion bar (01) and the required set it freezes.

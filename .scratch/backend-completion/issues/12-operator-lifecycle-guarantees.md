# 12: Set the operator-lifecycle guarantees

**Type:** grilling
**Status:** open
**Blocked by:** 01, 02

## Question

What operator-lifecycle guarantees does the backend owe the Instance Operator in this release?

Facts: signing keys come from `IDENTIK_SIGNING_JWKS` with no rotation tooling (`oidc/signing-keys.service.ts`; the service documents "a rotation publishes the new key first"). Audit history has no retention or archival story. The Bootstrap Ceremony token is printed to stdout once and expires (`bootstrap.service.ts:86-90`; ADR-0021) with no documented recovery if the operator misses it. Backup/restore guidance was explicitly deferred to "the Dockerization phase" (ADR-0026 draft; postgres-migration spec).

Settle: is manual JWKS rotation with a documented overlap window enough, or is rotation tooling required; audit retention policy (unbounded for self-hosted? archival? required tooling?); Bootstrap Ceremony recovery and token re-issue; backup/restore expectations the backend must enable; and the upgrade/version story an operator can rely on.

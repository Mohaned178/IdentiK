# 02: Lock the deployment topology assumption

**Type:** grilling
**Status:** resolved
**Blocked by:** 01

## Question

What deployment shape must this backend support in this release, and what may it explicitly not support?

Facts: ADR-0001 fixes self-hosted, single-tenant operation as the primary artifact. The PostgreSQL migration left the single-process assumption and the in-memory throttle untouched and deferred shared state ("the in-memory throttle is unchanged and the single-process assumption is untouched", postgres-migration spec, Out of Scope). Dockerization implies one long-running Instance process and one PostgreSQL — but not necessarily exactly one replica.

Settle: is the supported topology exactly one Instance process (one replica) plus one PostgreSQL, with rolling multi-replica operation explicitly unsupported and documented? Or must the backend tolerate concurrent replicas and overlapping process lifetimes? Also settle graceful restart semantics (in-flight request drain, Prisma pool shutdown) and the supported PostgreSQL version range (CI pins 18).

This decision is the input for honest throttle state (07), readiness semantics (04), migration rollout (05), operator expectations (12), and the observability shape (13).

## Answer

**Topology.** The supported shape is exactly one Instance process against one PostgreSQL. Multiple replicas and overlapping process lifetimes are explicitly unsupported this release; the constraint is documented for the operator, not structurally enforced (no startup lock).

**Restart contract.** A restart drains: on shutdown the process stops accepting new connections and lets in-flight requests finish within a short bound (~10s), then exits; the existing Prisma pool disconnect follows. In-flight requests are never deliberately cut. The readiness flip on SIGTERM is decided by "Define the health and readiness contract"; this ticket fixes only the drain contract and its bound.

**Database envelope.** PostgreSQL 18 is the only supported version — the one CI proves; older majors are untested and documented as unsupported, with no runtime version gate (any gate belongs to "Decide the production configuration contract"). A direct connection is the supported path; transaction-mode poolers (PgBouncer) are untested, documented as unsupported this release, and require no pooler-specific configuration.

**Consequences.** The in-memory throttle is acceptable because state never spans processes (its floor is decided in "Harden abuse-protection state for the deployment"). Migrations may assume a single migrating process ("Sequence database migrations for deployment"). Readiness and operational signals need no cross-replica aggregation ("Set the observability floor"). Operator expectations are single-instance operation with brief, bounded restart downtime ("Set the operator-lifecycle guarantees").


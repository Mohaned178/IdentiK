# 04: Define the health and readiness contract

**Type:** grilling
**Status:** resolved
**Blocked by:** 01, 02

## Question

What health and readiness surface does a containerized Instance expose?

Facts: a single `GET /health` probes the mail transport only (`health.controller.ts:15-19`; `mail/mail.service.ts:25-30`); PostgreSQL is unprobed, so a database outage after boot reports `ok`. The PostgreSQL migration explicitly deferred DB health checks (postgres-migration spec, Out of Scope). The e2e harness treats `/health` as its ready probe (`e2e/src/instance.ts:170-185`).

Settle: one endpoint or a liveness/readiness split; what each checks (process liveness, PostgreSQL connectivity, migrated schema, mail transport); status codes and response body; whether "degraded" is a state and what the container health check should target; and how the existing `/health` contract and the e2e ready probe migrate.

## Answer

**Shape (Q1).** Two endpoints plus an alias: `GET /health/live` (process only) and `GET /health/ready` (dependency checks); `GET /health` remains as an alias of readiness. Docker HEALTHCHECK targets `/health/ready`; orchestrator liveness probes target `/health/live`. The e2e harness ready probe moves to `/health/ready`, and the walking-skeleton and SMTP-binding assertions follow the new body.

**Readiness semantics (Q2).** Readiness gates on a PostgreSQL `SELECT 1` with a short timeout (≤2s), uncached; the migrated-schema check stays a boot-time gate. An unreachable database is 503. Mail stays diagnostic per ticket 20: an unreachable relay surfaces as `degraded`, never a 503, and keeps its 5s reachability cache.

**Response contract (Q3).**

- `GET /health/live` → `{ "status": "ok" }`, 200 while the process serves.
- `GET /health/ready` → `{ "status": "ok" | "degraded" | "unavailable", "checks": { "database": { "ok": boolean }, "mail": { "binding", "reachable" } } }` — 200 for `ok`/`degraded`, 503 for `unavailable`.

Coarse booleans only — no hosts, error strings, or timestamps. Both endpoints stay unauthenticated and carry nothing sensitive.

**Shutdown (Q4).** On SIGTERM, readiness reports `unavailable` immediately, in-flight requests drain within the topology ticket's ~10s bound, and liveness keeps answering `ok` until the process exits.


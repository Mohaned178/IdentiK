# 06: Document the operator envelope for the floor

**What to build:** A committed operator guide states the supported shape the floor guarantees: one Instance process against one PostgreSQL with multiple replicas unsupported, PostgreSQL 18 only over direct connections with transaction-mode poolers unsupported, the explicit migrate-then-start sequence with the default single role and the documented split-role pattern, the development opt-in, proxy trust, and TLS termination at the proxy with the base URL defining the public origin.

**Blocked by:** 01 — Enforce fail-closed configuration at startup; 04 — Gate startup on migration state and ship the pinned CLI; 05 — Honor proxy trust and set the browser edge posture

**Status:** ready-for-agent

- [ ] The guide covers topology, the database envelope, the migration sequence and roles, the development opt-in, proxy trust, and TLS/base-URL expectations.
- [ ] Every claim matches the implemented behavior and the published spec.
- [ ] No secrets, hosts, or environment-specific values appear in the guide.

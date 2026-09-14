# 02: Expose liveness and readiness endpoints

**What to build:** The Instance exposes a liveness surface and a readiness surface. Readiness honestly reports PostgreSQL with a short bounded probe and answers unavailable when the database is unreachable, recovering when it returns; the mail relay is reported as degraded only and never gates readiness; responses expose no infrastructure detail. The existing health path keeps answering as the readiness alias, and the test harness probes readiness.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] `/health/live` answers 200 `{ "status": "ok" }` while the process serves.
- [ ] `/health/ready` answers 200 for `ok` and `degraded`, 503 for `unavailable`; making PostgreSQL unreachable flips it and restoring connectivity recovers it.
- [ ] An unreachable mail relay yields `degraded`, never 503, and no relay endpoint or error text appears in the body.
- [ ] Bodies carry no hosts, error strings, or timestamps; both endpoints stay unauthenticated.
- [ ] `/health` answers as the readiness alias; the e2e harness uses `/health/ready` as its ready probe.
- [ ] Suite green.

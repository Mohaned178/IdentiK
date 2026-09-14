# 03: Drain in-flight requests on shutdown

**What to build:** A clean shutdown stops accepting new work, flips readiness to unavailable immediately, lets in-flight requests finish within the ~10s bound, then exits; liveness answers until the process ends. A restart therefore costs a brief, bounded downtime and never deliberately cuts a request.

**Blocked by:** 02 — Expose liveness and readiness endpoints

**Status:** ready-for-agent

- [ ] On SIGTERM, readiness reports `unavailable` immediately.
- [ ] A request in flight at SIGTERM completes successfully.
- [ ] The process exits within the drain bound once in-flight work finishes.
- [ ] Liveness keeps answering until exit.
- [ ] Suite green.

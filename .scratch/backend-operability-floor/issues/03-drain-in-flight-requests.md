# 03: Drain in-flight requests on shutdown

**What to build:** A clean shutdown stops accepting new work, flips readiness to unavailable immediately, lets in-flight requests finish within the ~10s bound, then exits; liveness answers until the process ends. A restart therefore costs a brief, bounded downtime and never deliberately cuts a request.

**Blocked by:** 02 — Expose liveness and readiness endpoints

**Status:** done

- [x] On SIGTERM, readiness reports `unavailable` immediately.
- [x] A request in flight at SIGTERM completes successfully.
- [x] The process exits within the drain bound once in-flight work finishes.
- [x] Liveness keeps answering until exit.
- [x] Suite green.

## Comments

- New work submitted while draining is refused with `503 { "error": "shutting_down" }` — only `/health`, `/health/live`, and `/health/ready` keep answering — and the adapter force-closes any connection still open when the drain window ends (the bound is the exit guarantee, not just a wait).
- Draining readiness answers `unavailable` with no probes (no `checks` in the body), so the flip is immediate even when a dependency probe would be slow; the probed shape from ticket 02 is unchanged for the ready/degraded and database-down cases.
- Signal handlers are installed before the listener resolves, so a signal during boot cannot cut an Instance that has not started serving.
- The e2e test is skipped on Windows (`child.kill` terminates forcefully there); CI runs it on Linux. The same path was verified locally with an in-process `process.emit('SIGTERM')`: readiness 503, liveness 200, new work 503, in-flight 401 completion, exit code 0 within ~40 ms of the in-flight response.

# 05: Define the deploy and rollback runbook

Type: grilling

Status: resolved

Blocked by: 01, 04

## Question

Given the image interface (ticket 01) and the tag source (ticket 04), what is the exact deploy sequence and rollback story? The settled mechanics: a repo-held deploy script plus runbook, executed manually over SSH — pull the pinned tag, run the one-off migrate container, recreate `app`, verify `/health/ready` before calling it done; rollback is the previous tag, safe because the floor tolerates a database ahead of the app across additive migrations.

Resolve: the script/runbook contents step by step, the verify step's exact checks, the rollback procedure including what the operator does when a migration is *not* safely reversible (state the additive-only migration policy for this phase or decide the alternative), and what "full CD later" is waiting on. Confirm placement: runbook required-for-live, CD deferred.

## Answer

**Decided (all grilling recommendations approved):**

- **Deploy unit:** the VPS holds a git checkout pinned at the release tag — compose file, Caddyfile, script, and image tag move as one versioned unit, and the script asserts checkout == tag before acting. No standalone file copies, no stack/image skew outage category.
- **Sequence:** pull → checkout tag → one-off migrate (`run --rm app migrate`) → recreate `app` → verify. The order is belt-and-braces over the boot gate, which fails safe (refuses to serve a behind database, naming the command) if migrate is ever skipped.
- **Verify:** HTTPS `GET /health/ready` through the proxy, expecting HTTP 200 **and** body `database.ok == true`, polled to a timeout. Mail-degraded is acceptable — a relay blip never fails a deploy. Status-only checks are banned: they bless apps that can't reach their database.
- **Migration policy (runbook verbatim):** additive-only this phase — nothing dropped or renamed in the same release as code that stops reading it. A failed migrate is fixed forward; the database is never rolled back (migrations run transactionally per-migration on Postgres).
- **Rollback:** re-apply the running image reference and git tag captured *before* the deploy acted — no bookkeeping file, no second truth. Safe by construction under the additive-only invariant.
- **Script form:** `deploy/deploy.sh`, `set -euo pipefail`, every action echoed, each step gated on the last; run over SSH under supervision. A checklist that executes, not automation that decides.
- **CD stays deferred** (map scope); it waits on the runbook proving itself by hand, judged at end-of-dogfooding. Placement confirmed: runbook required-for-live.

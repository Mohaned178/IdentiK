# Production live Instance

## Destination

Every decision required to stand up and keep running a genuinely live, production IdentiK Instance — image/runtime, topology, persistence and backup/restore, migrations in deploy, secrets, proxy/HTTPS, public origin, health/recovery, observability, failure expectations, deploy/rollback, release flow, data durability — resolved and separated into required-for-live / optional-polish / explicitly-deferred, with nothing left to decide before execution. This map produces decisions only; the deployment execution is the follow-on effort it hands off to.

## Notes

- Authority documents: `CONTEXT.md`, `docs/adr/0001`–`0027`, the MVP spec (`.scratch/identity-platform-mvp/spec.md`), the PostgreSQL + Prisma migration spec (`.scratch/postgres-migration/spec.md`), the backend operability floor spec (`.scratch/backend-operability-floor/spec.md`), and the prior map (`.scratch/backend-completion/map.md`). Read the ADRs touching an area before deciding it; flag conflicts rather than silently override them.
- Planning only: every ticket resolves a decision, except `task` tickets, which complete operator-side provisioning that unblocks a decision. No implementation happens in this effort, and no implementation tickets are created here.
- This map does not redo floor decisions. The backend operability floor (fail-closed config, health/readiness split, migrate-then-start with pinned CLI and boot gate, edge posture, locked one-process/one-PostgreSQL topology) is the foundation; floor tickets 05–06 were in flight when this map was charted.
- It also does not absorb the backend-completion map's open tickets (Management API completeness, error contract, session/token edges, observability stack, client-surface freeze). Ticket 11 references that map's questions but must not silently import them.
- HITL tickets resolve with the human: call the Skill tool for `grilling` and `domain-modeling`. AFK task tickets are driven by the agent alone and resolve with findings.
- Standing decisions settled while charting (Rounds 1–2); tickets detail them, never relitigate them:
  - Single rented VPS running Docker; dogfooding-with-production-discipline (no real external users until the frontend lands, but operated as if real); backend-only live, no UI work in this effort.
  - Public origin is a dedicated subdomain of an already-controlled domain; real transactional mail relay required from day one with sender-domain deliverability records.
  - One multi-stage image with `server` + `migrate` entrypoint subcommands (migrate as one-off, never at start); tarball keeps shipping for non-Docker operators.
  - One compose stack: `app` + `postgres:18` (exact minor pinned) + Caddy, internal network, named pgdata volume, only the proxy publishing 80/443.
  - Caddy for automatic HTTPS; release flow builds version-tagged GHCR images on release tags; deploys pin exact tags, never floating ones.
  - Script-assisted manual deploy over SSH; full CD deferred until the runbook proves itself by hand.
  - Secrets in a root-owned `0600` host `.env` (ADR-0022); the env file including signing keys is in backup scope.
  - Nightly `pg_dump` + off-host copy + one drilled restore; RPO ≤ 24h accepted for dogfooding; PITR deferred.
  - Compose healthcheck probes liveness, never readiness; `restart: unless-stopped`; grace period covers the ~10s drain; external probe watches readiness.
  - Observability floor: container stdout + rotation caps + external readiness probe with operator alert + documented how-to-check; metrics/tracing/aggregation deferred.
  - Recovery: reboot, restore, and bad-deploy rollback are drilled before go-live; all other scenarios documented-only.
  - Minimal host baseline (firewall 22/80/443, key-only SSH, unattended security updates, official Docker repo).
  - No staging instance; the `verify` gate plus deploy-time readiness verification is the bar.
- Provisional placement (each ticket confirms or corrects its own): tickets 01–08, 10–11, 13–15 are required-for-live; ticket 09's drilled half is required, its documented-only half is required as prose; ticket 12 defines the acceptance bar itself. Optional-polish and deferred items live in Out of scope until a ticket proves one necessary.

## Decisions so far

- [Define the compose stack](issues/02-compose-stack.md): app + pinned postgres/caddy on an internal net, proxy-only 80/443, named pgdata + caddy_data volumes, `node -e` liveness probe (never readiness), 30s grace, Caddyfile read-only, `${IDENTIK_IMAGE_TAG:?}` required, conservative resource caps.

- [Define the production image](issues/01-production-image.md): `node:24-slim` pinned minor, non-root, amd64-only, no in-image HEALTHCHECK, fresh prod-only install in runtime stage, shell entrypoint with `server`/`migrate`; Alpine out (glibc engines), distroless and arm64 deferred, tarball unchanged.
- [Prove the Management API can operate the live Instance](issues/11-operator-api-sufficiency.md): Sufficient — every go-live operator task (bootstrap, invitations, applications, secrets, redirect URIs, settings, identities, audit) has a route; no blockers. Gaps flagged outward to the backend-completion map: no admin password rotation, no invitation listing/revocation, no admin listing/role-change/removal. Runbook wrinkles recorded: one-time setup token in logs, no `/setup` page (use `POST /api/setup`), cookie-jar curl.

- [Extend the release flow with the image](issues/04-release-flow.md): version + short-SHA tags, no `latest`, digest in release notes, image-level artifact assertion before push, provenance attestation, PR builds without push, strict atomic ordering, `GITHUB_TOKEN` only. (Body's "multi-arch" corrected to amd64-only per the image decision.)

- [Define the deploy and rollback runbook](issues/05-deploy-rollback-runbook.md): pinned-checkout deploy unit, pull → migrate → recreate → body-checked readiness verify, additive-only migration policy with fix-forward rule, rollback by captured previous values, supervised `deploy.sh`. CD stays deferred.

- [Settle secrets and the signing-key story](issues/06-secrets-and-signing-keys.md): `keygen` entrypoint subcommand (amends the image shape), gitignored `0600 deploy/.env` with interpolated single password, rotation procedure stated from the existing first-signs/all-verify mechanism, recreate-to-apply rule, `.env` in backup scope inviolable.

## Not yet specified

- **Postgres minor-version upgrade procedure.** How the live Instance moves 18.x→18.y (and one day a major) without breaking the migrate-then-start sequence or the backup story; sharpens once the compose stack and backup tickets land.
- **Log-volume experience.** Whether rotation caps and the stdout posture survive months of live traffic, or need tuning; revisit after the Instance has run.
- **End of dogfooding.** The trigger and decision to admit real users — PITR, staging, metrics, and CD all hang off it; graduates as a fresh effort, not a resumption of this map.
- **Frontend deployment onto this Instance.** A separate future effort; this map only guarantees the Instance is a sound foundation for it.
- **Data lifecycle sweeps.** Owned by the backend-completion map's fog; if that map ever mandates a sweep, this map's backup/restore story amends to cover it.

## Out of scope

- **Staging instance:** deferred to the real-user phase; the dogfooding Instance is its own canary.
- **Kubernetes, multi-replica, cloud-specific infrastructure:** ruled out by the locked topology and this effort's brief; the map stays portable single-host.
- **Frontend implementation:** a future effort on this foundation; no UI work enters this map.
- **Observability stack:** metrics, tracing, log aggregation, alerting infrastructure — deferred until real users.
- **Full CD:** push-button deploys wait until the manual runbook proves itself.
- **PITR / WAL archiving / standby:** the durability story is pg_dump + off-host + drilled restore until real users.
- **Implementation and implementation tickets:** the follow-on execution effort, explicitly not this map.

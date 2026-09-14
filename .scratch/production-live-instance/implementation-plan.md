# IdentiK production live Instance — implementation plan

Status: ready-for-execution

Goal: from the current repository to a genuinely live, self-hosted, production-discipline dogfooding Instance — backend only, one VPS, Docker, one process + one PostgreSQL 18, manual SSH deploy.

This plan converts the resolved decisions of `.scratch/production-live-instance/map.md` (tickets 01, 02, 04, 05, 06, 11) plus the settled decisions in the effort brief into milestones and executable steps. It does not relitigate decisions and does not create tickets. The backend operability floor is already committed on `main` (fail-closed config, health split, SIGTERM drain, migration gate, edge posture). Nothing in the deploy path exists yet: no image, no stack, no release pipeline for images, no first release tag.

Every step states: **What changes / Why / Depends on / Verify / Type**.

---

## Milestone 1 — Production artifact

### 1.1 Dockerfile and `.dockerignore`

- **What changes:** Add a multi-stage `Dockerfile` on `node:24-slim` (exact minor pinned) targeting `linux/amd64`. Build stage: `npm ci`, `npm run build` (Prisma generate + Nest build). Runtime stage: fresh `npm ci --omit=dev`, copy `backend/dist`, `backend/prisma`, `backend/prisma.config.ts` side by side so the migration gate's anchor (`dist/../../prisma/migrations`) resolves; run as the image's built-in non-root `node` user; no in-image `HEALTHCHECK`. Add `.dockerignore` excluding `node_modules`, `.git`, `dist`, `e2e`, `.scratch`, `docs`, `.agents`, `.github`, `deploy`, `.env`.
- **Why:** The floor ships behavior; the image ships the artifact with its migrations and the exact-pinned Prisma CLI the boot gate requires. Non-root, slim (glibc for Prisma engines), amd64-only, compose-owned probe — all per decisions 01/02.
- **Depends on:** Nothing in flight.
- **Verify:** `docker build` succeeds; image runs non-root; `/app/backend/prisma/migrations` present; `prisma@7.10.0` present in `node_modules`; no `.env`/`.git`/`e2e`/`.scratch` inside; `docker run --rm <image> server` boots with a test env.
- **Type:** code.

### 1.2 Entrypoint with `server`, `migrate`, `keygen`

- **What changes:** Add a small shell entrypoint: `server` (default → `node dist/main.js`), `migrate` (→ pinned `prisma migrate deploy`), `keygen` (→ prints a fresh RS256 JWKS to stdout for pasting into `.env`; `jose` is already a production dependency, no new packages). Wire it as the image entrypoint.
- **Why:** Migrate-is-explicit becomes structural, not conventional; `keygen` is the sanctioned amendment to decision 01 and the only missing piece of the signing-key story (decision 06).
- **Depends on:** 1.1.
- **Verify:** `docker run --rm <image> keygen` emits valid private-first RS256 JWK JSON; `migrate` applies to a scratch PostgreSQL 18 with no registry access; `server` boots; no subcommand starts migrations.
- **Type:** code.

---

## Milestone 2 — Deployment stack

### 2.1 Compose stack, PostgreSQL persistence, healthchecks and restart behavior

- **What changes:** Add `deploy/docker-compose.yml`. `app`: image `${IDENTIK_IMAGE_TAG:?}`, no published ports, `restart: unless-stopped`, `stop_grace_period: 30s` (3× the 10s drain), liveness-only healthcheck (`node -e` fetch on `/health/live`, 30s/5s/3, 60s start period), `depends_on` Postgres healthy, conservative adjustable resource caps, json-file log rotation (10 MB × 3, adjustable). `postgres:18.<exact-minor>`: named `pgdata` volume, `pg_isready` healthcheck, no published ports, `restart: unless-stopped`. `proxy` (`caddy:<exact>`): publishes 80/443 only, named `caddy_data` volume, Caddyfile bind-mounted read-only. One stack-private network with an explicit subnet. No floating tags.
- **Why:** Locked topology (one process, one database), proxy-only ingress, persistence unit, and the liveness-vs-readiness split so a database blip can never get the container killed. The stop grace period must exceed the drain bound.
- **Depends on:** 1.1–1.2 for smoke testing.
- **Verify:** `docker compose config` valid; stack healthy on a scratch host; Postgres and app unreachable from the host; `/health/live` healthy; `docker kill -s TERM app` drains within grace; services return after a Docker daemon restart; only proxy publishes ports.
- **Type:** configuration.

### 2.2 Reverse proxy, TLS, and proxy trust

- **What changes:** Add `deploy/Caddyfile`: site address from the Instance hostname, automatic HTTPS, HTTP→HTTPS redirect owned by Caddy, `reverse_proxy app:3000` (Caddy appends the real client to `X-Forwarded-For`; it does not trust inbound XFF). `.env` carries `IDENTIK_HOSTNAME`; compose derives `IDENTIK_BASE_URL=https://${IDENTIK_HOSTNAME}` as a single source of truth. Set `IDENTIK_TRUST_PROXY` to the stack network CIDR (hop count `1` acceptable alternative) — never `true`, never `loopback` (the direct peer is the Caddy container).
- **Why:** TLS terminates at the proxy; the app never redirects; the app must know its real public origin (links, `Secure` cookies, HSTS) and must see honest client sources for throttling and audit without trusting the open internet.
- **Depends on:** 2.1; hostname from 5.2 for the final config (write with placeholder, fill at provisioning).
- **Verify:** `https://<hostname>` serves a valid ACME cert; `http://` redirects; forged `X-Forwarded-For` from outside does not alter the audit source; certs survive proxy recreation (caddy_data persists).
- **Type:** configuration.

### 2.3 Production env/secrets and signing-key lifecycle

- **What changes:** Add a `deploy/.env` template documenting the exact host secret set: `POSTGRES_PASSWORD`, `IDENTIK_HOSTNAME`, `IDENTIK_IMAGE_TAG`, `IDENTIK_SIGNING_JWKS`, `SMTP_*`, `MAIL_FROM`, `IDENTIK_TRUST_PROXY`. `DATABASE_URL` is composed from `POSTGRES_PASSWORD` by interpolation — one secret, used twice, unable to disagree with itself. The real file is installed root-owned `0600` and is already covered by the `.env` ignore rule (confirm with `git check-ignore deploy/.env`). Document: `keygen` → paste into `.env`; rotation = prepend new private key → recreate app → wait out the longest TTL (refresh default 30 days) → drop old key → recreate; emergency full replacement is documented break-glass that invalidates outstanding tokens. Every secret change applies by service recreate. No `IDENTIK_DEV_MODE`, no `IDENTIK_TEST_DATABASE_URL` on the host.
- **Why:** Secrets stay deployment-held (ADR-0022); losing the signing keys silently invalidates every Session and token, so minting, rotation, and backup are explicit. The `.env` is inviolably in backup scope.
- **Depends on:** 1.2 (`keygen`), 2.1.
- **Verify:** boot with generated keys shows no ephemeral-key warning; JWKS publishes the configured `kid`s; a rotation dry-run keeps pre-rotation tokens verifiable during the overlap window; `.env` confirmed untracked.
- **Type:** configuration + documentation (install steps are manual).

---

## Milestone 3 — Operations tooling

### 3.1 Deploy/rollback script and operator runbook

- **What changes:** Add `deploy/deploy.sh` (`set -euo pipefail`, every action echoed, each step gated on the last): assert clean checkout pinned exactly at the target tag → capture the previous image tag and git tag → `docker compose pull` → one-off `run --rm app migrate` → recreate `app` → poll HTTPS `/health/ready` for 200 **and** body `database.ok == true` to a timeout → print the rollback command on failure. Add the runbook: normal deploy, rollback by re-applying the captured previous tag (safe by construction: additive-only migrations, DB-ahead tolerated), additive-only migration policy with fix-forward, recreate-to-apply config, setup-token capture, and the operator curl runbook for bootstrap/invite/application registration (cookie jar; `POST /api/setup`; no `/setup` page exists).
- **Why:** Manual SSH/scripted deployment is the accepted bar and must execute the floor's migrate-then-start sequence. Rollback must be one previous exact tag with no bookkeeping file. Ticket 11 left only an outline; the runbook is its text.
- **Depends on:** 1.2, 2.1–2.3.
- **Verify:** Script executes end-to-end on a scratch instance; readiness body check passes; runbook can be followed verbatim by someone who has not read the source; the printed rollback command restores a bad deploy.
- **Type:** code + documentation.

### 3.2 Backup and restore

- **What changes:** Add `deploy/backup.sh` + documented restore. Root cron nightly: `pg_dump -Fc` via `docker compose exec -T postgres` into a host staging directory; include `deploy/.env` (encrypt if the destination is not private); keep 7 dumps on-host; copy off-host with ~30-day retention; exit non-zero on any failure so it is noticed. Restore procedure: stop app, fresh volume, restore dump + `.env`, start, verify readiness, bootstrap state, and Administrator sign-in. State RPO ≤ 24h as accepted for dogfooding.
- **Why:** Backups are required before live and restore must be drilled; PITR is deferred.
- **Depends on:** 2.1; destination from 5.4.
- **Verify:** First run produces a non-zero dump on-host and off-host; checksum/size match; the restore checklist is the exact script used by drill 6.2.
- **Type:** code + documentation.

### 3.3 Observability floor, recovery matrix, host baseline checklist

- **What changes:** Documentation plus small config: the json-file rotation caps from 2.1; an external uptime probe on `https://<hostname>/health/ready` (5-minute interval, alert after 2 consecutive failures, operator email) plus TLS-expiry monitoring; an operator "how to check the Instance" note (`docker compose ps`, `logs app`, health endpoints, backup freshness, disk); a failure/recovery matrix (VPS reboot, process crash, bad deploy, DB loss/corruption, disk full, signing-key loss, relay outage) with detection, recovery steps, expected downtime, and which rows are drilled; a PostgreSQL minor-upgrade procedure (backup-first, bump pinned minor, verify) and the major-upgrade note (dump/restore). Host baseline checklist: key-only SSH, firewall 22/80/443, unattended security updates with a deliberate reboot policy, Docker from the official repo + compose v2, deploy directory ownership.
- **Why:** One operator needs a floor that detects trouble and a written answer for every plausible outage; metrics/tracing/aggregation are deferred by decision.
- **Depends on:** 2.1, 3.1.
- **Verify:** Probe green with a tested alert path; every matrix row has a recovery step; checklist verified against the provisioned host in 5.1.
- **Type:** documentation + configuration (probe account is manual).

---

## Milestone 4 — Release pipeline

### 4.1 Image publishing in the release flow

- **What changes:** Extend `.github/workflows/release.yml`: after the existing verify/build/e2e gate, build `linux/amd64` with buildx; **assert the artifact before push** (migrations directory present, `prisma --version` exactly `7.10.0`); push `ghcr.io/mohaned178/identik:vX.Y.Z` and `:sha-<short>` with build-provenance attestation (`packages:write`, `id-token:write`, `GITHUB_TOKEN` only); keep the tarball shipping unchanged; add the image digest to the release notes alongside the tarball checksum. Strict order: verify → build → assert → push → tarball → release; any failure stops everything after it. No `latest` or floating tags. Add a PR job that builds the image without pushing when backend/Dockerfile/deploy paths change.
- **Why:** Deploys pull the exact tag CI tested; the artifact assertion catches the floor's silent breaks; PR builds stop Dockerfile rot from reaching release night.
- **Depends on:** 1.1–1.2.
- **Verify:** Tag push yields a GHCR image with both tags and a verifiable attestation; the assertion fails on a deliberately broken image; PR build runs push-less; the tarball is byte-identical in shape.
- **Type:** code (CI).

### 4.2 First release tag

- **What changes:** Commit the current dirty tree, confirm `npm run verify` is green, choose the first version (`v0.1.0`), push the tag, and record the image digest and tarball checksum. Decide GHCR pull access (public package for simplicity, or a read-only token stored on the host).
- **Why:** The whole deploy chain addresses an exact image tag; none exists yet (only `main-initial`).
- **Depends on:** Milestones 1–3 merged, 4.1.
- **Verify:** `docker pull ghcr.io/mohaned178/identik:v0.1.0` succeeds on the host; release notes carry digest + checksum.
- **Type:** release (manual trigger).

---

## Milestone 5 — Provisioning and first deploy

*Milestone 5 is human/operator work and can start in parallel with Milestones 1–4; 5.5 is the synchronization point that requires the first release image.*

### 5.1 VPS and host baseline

- **What changes:** Rent one Docker-capable Linux VPS (suggest ≥2 vCPU / 4 GB / 40 GB SSD; provider and size are the operator's call), with root SSH for the operator, then apply the 3.3 checklist.
- **Why:** Hosting decision; the host is part of the trust fabric.
- **Depends on:** Nothing repo-side.
- **Verify:** SSH key-only works; firewall allows only 22/80/443; Docker + compose installed from the official repo; unattended updates configured; `/opt/identik` created.
- **Type:** infrastructure + manual.

### 5.2 Domain

- **What changes:** Point the dedicated subdomain (e.g. `id.<domain>`) A/AAAA at the VPS; record `IDENTIK_HOSTNAME` and the public origin.
- **Why:** The public origin drives links, cookie `Secure`, HSTS, and ACME issuance.
- **Depends on:** 5.1.
- **Verify:** `dig` resolves to the VPS; Caddy issues a cert once the stack runs.
- **Type:** manual/infrastructure.

### 5.3 Real SMTP relay

- **What changes:** Provision the relay (provider is the operator's call): account, SMTP credentials, `MAIL_FROM` on the sender domain, SPF + DKIM + DMARC records with provider instructions; record sending limits.
- **Why:** Real mail is required for verification, reset, and invitation flows from day one.
- **Depends on:** 5.2 for domain records.
- **Verify:** Provider reports SPF/DKIM/DMARC pass; a test send to an external mailbox arrives outside spam; values ready for `deploy/.env`.
- **Type:** manual/infrastructure.

### 5.4 Off-host backup destination

- **What changes:** Prepare the off-host location (object storage, second machine, or another location the operator names) with write access from the VPS, root-only credentials/config, and a stated retention capacity.
- **Why:** A dump on the same disk is not a backup; dumps and `.env` must leave the host.
- **Depends on:** 5.1 for access.
- **Verify:** Test upload/download/delete from the VPS succeeds; capacity recorded.
- **Type:** manual/infrastructure.

### 5.5 Install the stack and first deploy

- **What changes:** Check out the pinned release tag under `/opt/identik`; install `deploy/.env` root-owned `0600` (password via `openssl rand`, `keygen` output pasted); authenticate GHCR if the package is private; `docker compose pull`; one-off `app migrate`; `docker compose up -d`; verify readiness through the proxy; capture the setup token immediately from `logs app`.
- **Why:** This is the tested deploy sequence executed by hand for the first time, from the exact released artifact.
- **Depends on:** 4.2, 5.1, 5.2 (5.3/5.4 needed before go-live, not before boot).
- **Verify:** `/health/ready` 200 with `database.ok=true`; valid cert; HSTS present; `GET /api/setup/status` shows `available=true`; token captured.
- **Type:** manual (script-assisted).

### 5.6 Bootstrap and first operator setup

- **What changes:** Complete the Bootstrap Ceremony via `POST /api/setup?token=…`; sign in with a cookie jar; register the first Application (web type → store the one-time client secret); optionally invite a second Administrator; inspect audit. Warning: complete bootstrap before any app recreate — a restart mid-ceremony forces reinstall, and the token cannot be re-revealed.
- **Why:** It is the only way the first Owner exists and it proves the operator API is usable without a dashboard.
- **Depends on:** 5.5.
- **Verify:** Setup status `completed=true`; sign-in works; Application registered; audit shows `bootstrap.completed`.
- **Type:** manual.

### 5.7 Backups running off-host

- **What changes:** Install the root cron from 3.2; run `backup.sh` once by hand; confirm dump + `.env` copy on-host and off-host; record the freshness-check command.
- **Why:** Backups must be running before the Instance counts as live.
- **Depends on:** 5.5, 3.2, 5.4.
- **Verify:** Off-host artifact present, dated, non-zero, checksum matching; cron log clean.
- **Type:** operational/manual.

### 5.8 Uptime probe and alert path

- **What changes:** Configure the external monitor on `/health/ready` and the alert channel from 3.3; send a test alert.
- **Why:** The minimum observability is the operator's only out-of-band detection.
- **Depends on:** 5.5.
- **Verify:** Probe green; test alert received.
- **Type:** manual + configuration.

---

## Milestone 6 — Drills and go-live acceptance

### 6.1 Reboot drill

- **What changes:** Reboot the VPS; confirm all services return via `restart: unless-stopped` and readiness recovers.
- **Why:** Proves unattended recovery from the most common host event.
- **Depends on:** 5.5, 5.7.
- **Verify:** After reboot: stack healthy, `/health/ready` 200, probe green, downtime within the matrix expectation. Record date and result.
- **Type:** manual (drill).

### 6.2 Restore drill

- **What changes:** Restore per 3.2 into a fresh volume (not the live one); verify readiness, bootstrap completed, Administrator sign-in, and audit rows present; then revert to the live volume.
- **Why:** An undrilled backup is not a backup.
- **Depends on:** 5.7.
- **Verify:** All checks pass with evidence; the procedure's wording is corrected against reality. Record date and result.
- **Type:** manual (drill).

### 6.3 Rollback drill

- **What changes:** Deploy a previous image tag (or simulate a bad deploy by setting the previous `IDENTIK_IMAGE_TAG`), verify readiness, then return to the current tag.
- **Why:** Proves the additive-migration policy keeps rollback-by-tag safe.
- **Depends on:** 5.5.
- **Verify:** Readiness 200 and body `database.ok=true` under the previous tag; return to current verified. Record date and result.
- **Type:** manual (drill).

### 6.4 Real mailbox round-trip, final acceptance, sign-off

- **What changes:** Execute the go-live acceptance checklist with pass criteria: HTTPS origin reachable with a valid cert; bootstrap completed with a real Owner; **a real mailbox proof round-trip through the relay** (sign-up verification, password reset, Administrator invitation); a backup sitting off-host; reboot + restore + rollback drills passed; probe green with a tested alert; deploy runbook executed once by hand; recovery matrix and how-to-check notes in place; `IDENTIK_DEV_MODE` absent and `MAIL_TRANSPORT_BINDING=smtp`. Sign off and declare the Instance live.
- **Why:** Closes the decision space; nothing remains to decide before operating.
- **Depends on:** 5.6–5.8, 6.1–6.3, 5.3.
- **Verify:** Every item checked with evidence; any failure blocks go-live.
- **Type:** manual acceptance.

---

## Recommended implementation order

Milestone 1 → 2 → 3 → 4 → 5.5–5.8 → 6.1–6.4, with 5.1–5.4 (provisioning) running in parallel with Milestones 1–4. 5.5 is the synchronization point: it requires both the first released image (4.2) and the provisioned host (5.1–5.2).

## Smallest reasonable number of implementation batches

Three batches:

1. **Deployable artifact + stack + ops tooling** (Milestones 1–3). All repo-side; verified by local `docker build/run`, `docker compose config`, and the existing `npm run verify` gate. Splits naturally into two PRs (image first, then stack/tooling) without changing the batch count.
2. **Release pipeline + first tagged image** (Milestone 4). A distinct verification surface (CI, registry) producing the artifact 5.5 consumes.
3. **Provision, deploy, drill, go live** (Milestones 5–6). Manual/operator work, partially parallelizable with batch 1 but gated on batch 2 for the deploy.

## Still genuinely missing before the first live deployment

- **Operator-supplied inputs:** VPS provider/size, domain, mail relay + credentials, backup destination + access, uptime probe vendor + alert channel, and the exact minor pins for `node`/`postgres`/`caddy` chosen at implementation time.
- **Repo preconditions:** the dirty working tree must be committed before tagging; no `v*` release tag exists; `deploy/.env` template, GHCR pull-access decision (public package vs. host registry login), and the written operator curl runbook (ticket 11 left only an outline) do not exist yet.
- **Concrete knobs to fix during implementation (defaults proposed in this plan):** Caddy trust value, backup schedule/retention/off-host mechanism and `.env` encryption, log rotation caps, resource caps.
- **Accepted known gaps (non-blocking for a single-operator dogfooding Instance):** no Administrator password-rotation API, no invitation listing/revocation, no Administrator listing/role management. The setup token is shown once and a restart before completion forces reinstall — captured in the runbook.
- **PostgreSQL minor-upgrade procedure** (backup-first) and the major-upgrade note belong in the recovery matrix before live (covered by 3.3).

## What should remain deferred

- Frontend/dashboard implementation.
- Kubernetes, multi-replica, overlapping process lifetimes, shared/persistent throttle state.
- PITR / WAL archiving / standby; RPO improvements beyond the accepted ≤ 24h.
- Staging instance; full CD.
- Metrics, tracing, log aggregation, alerting infrastructure.
- arm64 and distroless images; PostgreSQL majors other than 18; connection poolers.
- Signing-key rotation tooling beyond the documented manual procedure.
- The three Management API gaps (Administrator password rotation, invitation listing/revocation, Administrator listing/role management).
- Data lifecycle sweeps (lazy expiry remains).
- CSRF token machinery, `__Host-` cookie prefixes, audit retention/archival, branding asset upload, OpenAPI publication, a unit-test tier.
- Zero-downtime deploys.
- End-of-dogfooding graduation items (admitting real users, and the PITR/staging/metrics/CD that hang off it).

# 02: Define the compose stack

Type: grilling

Status: resolved

## Question

What is the exact compose-stack definition on the VPS — services (`app`, `postgres:18` with exact minor pinned, `proxy`), internal networking, the named pgdata volume, published ports (proxy only: 80/443), resource limits if any — together with the runtime posture: `restart: unless-stopped` everywhere, the `app` healthcheck probing **liveness** (`/health/live`, never readiness, so a brief database outage cannot get the container killed), a stop grace period covering the ~10s SIGTERM drain, and postgres `pg_isready` healthcheck with `depends_on`?

Resolve the full stack file shape and the liveness-vs-readiness split rationale, consistent with the floor's health contract.

## Answer

**Decided (all grilling recommendations approved):**

- **Services:** `app` (the ticket-01 image), `postgres:<exact-minor>` (e.g. `18.x`, bumped deliberately backup-first), `proxy` (`caddy:<exact>`). Pin policy: exact minors, never floating majors, never digests — digests turn every patch into archaeology for one operator.
- **Network/ports:** one internal network; only the proxy publishes 80/443. Postgres is unreachable off-stack.
- **Volumes:** named `pgdata` for Postgres; named `caddy_data` (+ config) for the proxy — Caddy's `/data` must persist or every recreation re-issues certs against Let's Encrypt rate limits. Caddyfile bind-mounted read-only.
- **Runtime posture:** `restart: unless-stopped` everywhere; `stop_grace_period: 30s` (3× the exact 10s `DRAIN_BOUND_MS`); `app` healthcheck is a `node -e` fetch probe on `/health/live` (no curl in the slim image, no new packages) at interval 30s / timeout 5s / retries 3 / start-period 60s — liveness only, so a database blip can never get the container killed; postgres `pg_isready` healthcheck with `depends_on` gating `app` startup only.
- **Proxy has no hard `depends_on` app:** Caddy self-heals against a restarting upstream; deploy-time readiness is the runbook's job (ticket 05), not compose ordering's.
- **File and wiring:** stack at `deploy/docker-compose.yml`; image arrives as a required variable (`${IDENTIK_IMAGE_TAG:?}` — compose fails fast on a missing tag instead of deploying `latest` by accident); all other secrets from the host `.env` owned by ticket 06.
- **Resource limits:** fixed conservative caps on app/postgres/proxy, marked adjustable — an uncapped box OOMs at the worst moment; host size refines the numbers at provision time.
- **Liveness-vs-readiness rationale (for the record):** liveness answers the process question (safe for the supervisor to act on); readiness answers the traffic question (safe for probes and deploy verification). Mixing them gets the app killed exactly when it should sit still.

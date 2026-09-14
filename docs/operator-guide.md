# Operator guide — the supported deployment envelope

This guide is for the **Instance Operator**: the party running one deployment of
the Identity Platform. It states the shape the platform supports and the
guarantees the deployment floor makes. Anything this guide does not list as
supported should be treated as unsupported, even where it might happen to work.

Domain vocabulary is defined in [`CONTEXT.md`](../CONTEXT.md), the authority on
what every term means. For every configuration variable, see
[`.env.example`](../.env.example), which is the authoritative list.

## Topology

- **One Instance process against one PostgreSQL server.** The Instance is a
  single long-running process; the database is its system of record.
- **Multiple replicas are not supported.** Do not run two Instance processes
  against the same database, and do not overlap an old and a new process during
  a deployment. Per-process state (the authentication throttle) would not be
  shared, and overlapping lifetimes buy nothing.
- **Restarts are safe, not seamless.** On `SIGTERM` or `SIGINT` the Instance
  stops accepting new work (the health surfaces excepted), flips readiness to
  unavailable immediately, lets requests already in flight finish within a
  bound of about 10 seconds, then closes any remaining connections and exits.
  During the drain, non-health requests receive `503` with
  `{"error":"shutting_down"}`. Expect a brief, bounded interruption per restart.
- **Liveness keeps answering until the process exits**; readiness flips at once
  so anything that routes by readiness stops sending work.

## Database

- **PostgreSQL 18 is the only supported server version.** That is the version
  the release is tested against; older majors are untested. The Instance does
  not check the server version at startup — this is a support statement, not an
  enforcement.
- **Direct connections only.** A transaction-mode connection pooler in front of
  PostgreSQL (for example PgBouncer) is not tested or supported; no
  pooler-specific configuration exists.
- **One database role works by default.** The `DATABASE_URL` role is used for
  both schema deployment and runtime.
- **A split-role setup is possible operator-side.** Run the migration command
  with a URL whose role may change the schema, and run the server with a URL
  whose role is limited to data access. No second variable is involved — each
  step supplies its own `DATABASE_URL`. The runtime role must also be able to
  read the migration bookkeeping table, because the server checks it at startup.

## Deploying schema changes

The server never changes the schema at boot. Deploying migrations is an
explicit, one-off step:

```sh
npx prisma migrate deploy
```

Run it against the deployment's `DATABASE_URL`, then start or replace the
Instance. A failed migration leaves the running version serving; a successful
additive migration is safe against the still-running version until it is
replaced. Concurrent migration attempts serialize on the migration tool's
advisory lock.

At startup the Instance compares the migrations shipped with the release against
the database's bookkeeping:

- a database **behind** the release refuses to serve, naming the command to run;
- a database **ahead** of the release (an applied migration this release has
  never heard of) is accepted, so rolling back across additive migrations stays
  safe;
- a release whose migrations directory is **missing or empty** refuses to serve
  — it cannot verify the database against the code it carries;
- a database **missing its core schema** refuses to serve, naming the command to
  run.

The release tarball ships `dist/` and `prisma/` side by side, with no
`node_modules`, so migrating straight from the tarball uses the pinned CLI
through the registry:

```sh
npx prisma@7.10.0 migrate deploy
```

An install that brings the production dependencies — the Prisma CLI among them,
exact-pinned — can run `npx prisma migrate deploy` without registry access.

**Configuration is fail-closed.** Required settings must be present; a value
that is present but invalid fails startup naming the setting; an absent optional
setting keeps its documented default. In production the required set includes
`DATABASE_URL`, `IDENTIK_BASE_URL`, `MAIL_TRANSPORT_BINDING`, and a stable
signing key set (`IDENTIK_SIGNING_JWKS`). Secrets — the database URL, the SMTP
credentials, the signing keys — are held in deployment configuration only and
are never addressable from the dashboard (ADR-0022).

## Development-only fallbacks

`IDENTIK_DEV_MODE=1` is the single opt-in that permits the development
fallbacks: the in-memory captured-mail binding (with its unauthenticated
development mail surface) and an ephemeral signing key generated at boot.

Without that opt-in, both are refused at startup. **Never set it in
production**: tokens would not survive a restart, and a development mail
surface would be exposed. See [`.env.example`](../.env.example) for the exact
variables.

## Behind a reverse proxy

TLS terminates at your proxy. The Instance itself serves plain HTTP behind it
and **never redirects HTTP to HTTPS** — that redirect belongs to the proxy.
`IDENTIK_BASE_URL` must be the externally reachable origin; it is the base for
verification, reset, and invitation links, it decides whether session cookies
are `Secure`, and it decides whether HSTS is sent.

- **Client source trust is off by default.** `IDENTIK_TRUST_PROXY` names the
  proxies whose forwarded headers may be trusted — `loopback`, a hop count, or
  an IP/CIDR list — and must match your proxy layout. Trusting everything
  (`true`) and zero-length prefixes are refused, because either would let any
  client forge the source that throttling and the audit surface depend on.
- **Baseline browser headers** are sent on every response: content-type
  sniffing disabled, referrer policy set to `no-referrer`, framing denied,
  and the framework banner suppressed. `Strict-Transport-Security` is sent
  only when `IDENTIK_BASE_URL` is an https origin.
- **Session cookies are host-only** (no `Domain`), `HttpOnly`, `SameSite=Lax`,
  `Path=/`, and `Secure` under an https origin.
- **No CORS surface exists.** All first-party clients are same-origin in this
  release; a cross-origin client is not supported. `SameSite=Lax`, same-origin
  access, and POST-only state changes are the cross-site request protection.

## Health and readiness

- `GET /health/live` — the process alone; answers `{"status":"ok"}` while the
  Instance serves.
- `GET /health/ready` — dependency readiness; answers `ok` or `degraded` with
  `200`, and `unavailable` with `503`. An unreachable database is
  `unavailable`; an unreachable mail relay is only `degraded`.
- `GET /health` remains an alias of readiness.

Responses carry coarse checks only — never hosts, error text, or timestamps.
Point liveness probes at `/health/live`, readiness probes and the container
health check at `/health/ready`.

## Unsupported by design

- Multiple Instance replicas or overlapping processes against one database.
- Transaction-mode connection poolers.
- PostgreSQL majors other than 18.
- TLS termination or HTTP-to-HTTPS redirects inside the Instance.
- Cross-origin browser clients.
- Development fallbacks (captured mail, ephemeral signing keys) in production.

## References

- The floor's specification: `.scratch/backend-operability-floor/spec.md`.
- Decisions: [`docs/adr/`](adr/), in particular ADR-0001 (self-hosted first),
  ADR-0022 (instance versus Organization settings), and ADR-0026/ADR-0027
  (PostgreSQL and Prisma).
- Configuration, verbatim: [`.env.example`](../.env.example).
- The deployment and operations runbook:
  [`deploy/README.md`](../deploy/README.md).

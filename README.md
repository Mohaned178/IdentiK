# IdentiK

A self-hostable Identity Provider — Keycloak without the pain. IdentiK lets a
team outsource identity and authentication for their applications into
infrastructure they control: one Instance, one PostgreSQL database, one
container image, and a standards-based OIDC surface any off-the-shelf client
library can speak. No SDK required.

## The problem

Every application needs sign-up, sign-in, password recovery, session
management, and audit — but embedding that into each app means every app owns
credentials, every app reimplements recovery, and nobody can answer "who did
what, when." Outsourcing it to a SaaS IdP means user data leaves your
infrastructure. Outsourcing it to a heavyweight IAM suite means operating a
platform to operate your platform.

IdentiK is the middle path: run one small Instance next to your apps. Your
apps keep their own authorization (roles and permissions stay your domain
data); IdentiK answers only *who this person is*, over standard OIDC, with
every security-relevant action on a unified audit surface.

## Core concepts

The vocabulary below is authoritative; [`CONTEXT.md`](CONTEXT.md) is the
glossary and wins where wording differs.

| Term | Meaning |
|---|---|
| **Instance** | One deployment of the platform, run by an **Instance Operator**. |
| **Organization** | The customer entity and trust boundary. Owns Applications and Identities. Exactly one per Instance today. |
| **Administrator** | A platform-side human (Owner or Member) who administers an Organization. A separate population from End Users, with separate credentials. |
| **Identity** | One person in one Organization: owns an email, credentials, and Sessions. Never owned by an Application. |
| **Enrollment** | An Identity's membership in one Application, created silently at first authentication. |
| **Session** | The durable record of one authentication — the revocable anchor that parents the SSO cookie and every refresh token minted from it. |
| **Application** | A registered client integration (Web/confidential or SPA-Mobile/public). Owns no Identities, only Enrollments. |
| **Mailbox Proof** | A single-use expiring value delivered by email; presenting it proves mailbox control. Sign-up, reset, email change, and invitations all rest on it. |
| **Management API** | The single programmatic surface; the dashboard is its first client. Callable by Administrator sessions. |
| **Account Center** | The platform-hosted self-service surface for End Users (Sessions, password, verified email change). |
| **Anonymization** | What deletion means here: PII destroyed, Sessions/Enrollments revoked, audit preserved pseudonymously, email immediately reusable. |

Unqualified "role" is banned vocabulary: it is either an **Administrator Role**
(ours: Owner or Member) or an application role (theirs — never stored here).

## What it does today

- **Bootstrap Ceremony** — one-time, expiring first-boot flow that creates the
  default Organization and its first Owner. The only way the first
  Administrator comes to exist; replay is refused.
- **Administrator auth** — dedicated sign-in/sign-out/session lifecycle,
  Owner/Member roles, invitation by email with the invitee choosing their own
  password, single-use expiring invitation links.
- **Organization settings** — branding, password policy, and session policy
  readable by every Administrator, writable by Owners only.
- **Applications** — Web (confidential, authorization code flow) and SPA/Mobile
  (public, PKCE) registration; concurrent labeled Client Secrets shown once and
  individually revocable; exact redirect-URI pinning with add/patch/remove;
  configurable scopes; reversible disable (authentication pauses, Sessions
  survive) and irreversible Owner-only delete.
- **Identities** — directory and detail views, Identity-level and
  Enrollment-level suspension, revoke-all-Sessions, Administrator force
  password reset (link to the mailbox, Sessions die now), anonymization with
  immediate email reuse.
- **End-User flows** — sign-up behind an email-verification gate (unverified
  reservations cannot authenticate), forgot/reset password, verified email
  change. Uniform responses that never reveal whether an email exists.
- **OIDC** — authorization endpoint with hosted sign-in and SSO, token
  exchange with PKCE, refresh rotation with reuse detection, revocation,
  introspection, UserInfo, JWKS, and discovery. Verified with a stock
  `openid-client`, no proprietary code.
- **Account Center API** — own-profile view, password change (changing device
  stays signed in, others are evicted), verified email change, per-Session
  revoke, sign-out as revocation.
- **Audit** — one unified, newest-first event surface covering bootstrap,
  invitations, applications, secrets, redirects, identities, sessions,
  enrollments, and authentication failures with source attribution.
- **Anti-abuse** — escalating per-source/per-Identity delays on public
  authentication surfaces, never a lockout (ADR-0020).
- **Operability** — fail-closed configuration, liveness/readiness probes,
  startup migration gate, graceful drain on SIGTERM/SIGINT, SMTP or captured
  mail bindings.

## Architecture

```
                ┌─────────────────────────────────────────┐
                │              IdentiK Instance             │
                │           (one Node.js process)         │
                │                                         │
Browsers ──────▶│ Hosted pages (sign-up / authorize /     │
& OIDC clients  │  reset / verify / account-center data)  │
                │                                         │
Dashboard ─────▶│ Management API (/api/...)               │
                │ OIDC (/api/oidc/..., discovery, JWKS)   │
                │ Health (/health/live, /health/ready)    │
                └───────────────┬─────────────────────────┘
                                │  Prisma
                                ▼
                        PostgreSQL 18
                     (system of record)
```

- **Backend** (`backend/`, NestJS + TypeScript): one module per domain
  (`administrators`, `identities`, `applications`, `enrollments`, `sessions`,
  `oidc`, `account-center`, `audit`, `bootstrap`, `settings`, `mail`,
  `throttle`, `health`, `lifecycle`, `storage`). Data access goes through
  Prisma; the server never migrates — startup refuses a database behind the
  release and names the migration command.
- **Single process, single database.** No replicas against one database, no
  overlapping deploys, no poolers in transaction mode. Restarts are safe
  (drain ≈ 10 s), not seamless.
- **Tests** (`e2e/`, Vitest): every behavior is proven over real HTTP against
  a real PostgreSQL (template database cloned per Instance) with captured
  email — never storage inspection, never mocks of the backend.

Decisions are recorded in [`docs/adr/`](docs/adr/) (27 records, including
superseded ones kept as history). Operator guarantees live in
[`docs/operator-guide.md`](docs/operator-guide.md).

## Technology stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 24 (see `.nvmrc`) |
| API framework | NestJS 11, Express |
| Language | TypeScript 5.7 |
| Database | PostgreSQL 18 |
| Data access | Prisma 7.10 (`@prisma/client` + `prisma` CLI) |
| Tokens | `jose` (JWKS, JWT verification) |
| Mail | Nodemailer (SMTP) or in-memory capture (dev/test) |
| E2E tests | Vitest, `openid-client`, `pg`, local SMTP harness |
| Packaging | Multi-stage Dockerfile (Node 24 slim), GHCR releases |

## Repository structure

```
.
├── backend/               # NestJS API + Prisma schema/migrations
│   ├── src/               # domain modules, OIDC, health, mail, storage
│   └── prisma/            # schema, migrations, prisma.config.ts
├── e2e/                   # black-box HTTP test suite (Vitest)
├── deploy/                # production stack (compose, Caddy, scripts, runbook)
├── local/                 # Docker Desktop development stack
├── docs/
│   ├── adr/               # architecture decision records
│   └── operator-guide.md  # supported deployment envelope
├── .github/workflows/     # CI (typecheck+build+e2e, image build) and release
├── .scratch/              # local issue tracker / specs (history, not runtime)
├── Dockerfile             # production image build
├── docker-entrypoint.sh   # server | migrate | keygen
├── .env.example           # authoritative configuration reference
└── CONTEXT.md             # domain glossary (authoritative vocabulary)
```

## Local development

Prerequisites: **Node.js 24** (`nvm use`), **npm**, and **PostgreSQL 18**.
The quickest local server:

```sh
docker run --name identik-postgres -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:18
```

```sh
npm ci            # install every workspace; generates the Prisma client
npm run dev       # backend in watch mode (configure the environment first)
```

The backend reads `process.env` directly — [`.env.example`](.env.example)
documents every variable; it is documentation, not a loader. Minimum for a
local boot:

```sh
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/identik
IDENTIK_BASE_URL=http://localhost:3000
MAIL_TRANSPORT_BINDING=capture
IDENTIK_DEV_MODE=1
```

`IDENTIK_DEV_MODE=1` permits captured mail and an ephemeral signing key. It is
refused in production-shaped configurations and must never be set outside
development.

### Migrations

The schema is created by an explicit step, never at boot:

```sh
cd backend
npx prisma migrate deploy   # DATABASE_URL must be set
```

The server gates startup on the release's migration state: a database behind
the release is refused with the migration command named; a database carrying
an unknown migration is tolerated.

### Tests

```sh
npm run typecheck   # backend + e2e
npm run build       # backend (prebuild regenerates the Prisma client)
npm run test -w e2e # full black-box suite: real backend + real PostgreSQL
npm run verify      # typecheck + build + e2e (what CI runs)
```

The E2E harness uses `IDENTIK_TEST_DATABASE_URL`
(default `postgresql://postgres:postgres@127.0.0.1:5432/postgres`) to create
one migrated template database per run and clone it per test Instance. One
test is platform-gated (graceful shutdown is skipped on Windows, runs on CI).

### Running the Docker / local stack

```sh
cd local
docker compose up -d --build   # builds identik:local, starts app + postgres
docker compose run --rm app migrate   # one-off migration (explicit, like prod)
curl http://localhost:3000/health/ready
```

See [`local/README.md`](local/README.md). Mail is captured at `/dev/mail`;
no proxy, no TLS — the browser talks to the app directly.

## Production deployment

High level (details in [`deploy/README.md`](deploy/README.md)):

1. Provision a host with Docker, PostgreSQL 18, and Caddy (or your proxy).
2. Set the production environment: `DATABASE_URL`, `IDENTIK_BASE_URL`
   (https), `MAIL_TRANSPORT_BINDING=smtp` + relay settings,
   `IDENTIK_SIGNING_JWKS` (stable key set from your secret manager).
   Never set `IDENTIK_DEV_MODE`.
3. Run migrations as a one-off (`migrate`), then start the server.
4. Complete the Bootstrap Ceremony from the console-revealed setup token.
5. Terminate TLS at the proxy and set `IDENTIK_TRUST_PROXY` to match your
   proxy layout only.

### Releases and images

Pushing a `v*.*.*` tag runs the release workflow: typecheck, build, full E2E,
image build, image assertion (migrations present, Prisma CLI pinned and
runnable), live smoke test (migrate + serve + readiness), then push to
`ghcr.io/mohaned178/identik` (`:<version>` and `:sha-<short>`) with build
provenance attestation, plus a backend tarball (`dist` + `package.json` +
`prisma/`) attached to the GitHub Release. The entrypoint supports `server`,
`migrate`, and `keygen` (mint a stable `IDENTIK_SIGNING_JWKS`).

## Security model and operational assumptions

- **Fail-closed configuration.** Required settings must be present; a
  present-but-invalid value fails startup; production refuses the
  captured-mail binding and ephemeral keys without the dev opt-in.
- **Secrets are verifiable-only.** Client Secrets are shown exactly once at
  generation and stored hashed; the signing key set lives in the Operator's
  secret manager, never in the repo.
- **Uniformity where it matters.** Sign-up, forgot-password, and failed
  sign-ins answer identically whether or not an email exists; throttling is
  keyed on the submitted value so delays never distinguish either.
- **Sessions anchor everything.** Revocation (sign-out, suspension,
  password change/reset, anonymization) kills Sessions and their refresh
  lineages immediately; access tokens are short-lived untracked bearers that
  die on schedule, with suspension/introspection flipping verdicts at
  ask-time.
- **We authenticate and assert; you authorize.** Application roles and
  permissions are client-application data — never stored, decided, or
  enforced here.
- **One process, direct database.** No shared throttle state across
  processes; SMTP relay failures degrade readiness, never silently drop mail
  posture; audit history is append-only and survives anonymization
  pseudonymously.

## Scope and non-goals

In scope today: password credentials, single Organization per Instance,
OIDC authorization-code flows for Web and SPA/Mobile clients, the surfaces
listed above.

Explicitly deferred (see ADRs): **MFA** (designed for, ADR-0017),
**federated/external identities** (ADR-0012), **multi-Organization hosted
mode**, user-granted scopes/permissions, and any authorization engine. The
throttle thresholds are deployment configuration, deliberately left open.

## Contributing

Read [`CONTEXT.md`](CONTEXT.md) first — every commit, ticket, and test speaks
its vocabulary — then [`CONTRIBUTING.md`](CONTRIBUTING.md) for the
idea-to-`main` workflow (conventional commits via commitlint, CI green on
typecheck + build + E2E). ADRs live in `docs/adr/`; specs and tickets live in
`.scratch/` per [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md).

## License

No license file is present in the repository yet.

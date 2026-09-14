# IdentiK

![Node version](https://img.shields.io/badge/node-24-5FA04E?logo=node.js&logoColor=white)
![PostgreSQL version](https://img.shields.io/badge/postgres-18-4169E1?logo=postgresql&logoColor=white)
![Prisma](https://img.shields.io/badge/prisma-7.10-2D3748?logo=prisma&logoColor=white)
![Standard OIDC](https://img.shields.io/badge/OIDC-standard_flow-EB5424)

> A self-hostable Identity Provider — Keycloak without the pain. One Instance, one PostgreSQL database, one container image, and a standards-based OIDC surface any off-the-shelf client library can speak. No SDK required.

Your apps keep their own authorization (roles and permissions stay your domain data); IdentiK answers only *who this person is*, over standard OIDC, with every security-relevant action on a unified audit surface.

## Quickstart

Prerequisites: **Node.js 24** (`nvm use`) and **PostgreSQL 18**.

```sh
# 1. Start a local PostgreSQL
docker run --name identik-postgres -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:18

# 2. Install and configure
npm ci
export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/identik
export IDENTIK_BASE_URL=http://localhost:3000
export MAIL_TRANSPORT_BINDING=capture
export IDENTIK_DEV_MODE=1

# 3. Migrate (explicit step, never at boot) and run
cd backend && npx prisma migrate deploy && cd ..
npm run dev
```

Then complete the Bootstrap Ceremony with the setup token printed to the console — it creates your Organization and its first Owner:

```sh
curl http://localhost:3000/health/ready
# {"status":"ok","checks":{"database":{"ok":true},...}}
```

> [!NOTE]
> `IDENTIK_DEV_MODE=1` permits captured mail (`/dev/mail`) and an ephemeral signing key. It is refused in production-shaped configurations — never set it outside development.

Prefer containers? The Docker Desktop stack builds the same production image with dev-only behavior:

```sh
cd local
docker compose up -d --build
docker compose run --rm app migrate   # one-off, like production
```

See [`local/README.md`](local/README.md).

## Features

- **Bootstrap Ceremony** — one-time, expiring first boot; replay is refused.
- **Administrators** — dedicated sign-in/session lifecycle, Owner/Member roles, email invitations with single-use expiring links.
- **Organizations** — branding, password policy, and session policy; readable by all Administrators, writable by Owners.
- **Applications** — Web (confidential) and SPA/Mobile (public, PKCE); concurrent labeled Client Secrets shown once and individually revocable; exact redirect-URI pinning; reversible disable and irreversible Owner-only delete.
- **Identities** — directory views, Identity- and Enrollment-level suspension, revoke-all-Sessions, force password reset, anonymization with immediate email reuse.
- **End-User flows** — verified sign-up gate, forgot/reset password, verified email change — with responses that never reveal whether an email exists.
- **Standard OIDC** — authorize + SSO, code exchange, refresh rotation with reuse detection, revocation, introspection, UserInfo, JWKS, discovery. Proven with a stock `openid-client`.
- **Account Center API** — own sessions, password change, verified email change, per-session revoke, sign-out as revocation.
- **Unified audit** — one newest-first event surface for every security-relevant action.
- **Anti-abuse** — escalating delays on public auth surfaces, never a lockout.
- **Operability** — fail-closed config, liveness/readiness probes, startup migration gate, graceful drain, SMTP or captured mail.

## Usage

### Configuration

The backend reads `process.env` directly. [`.env.example`](.env.example) is the authoritative reference — required settings, token/session windows, throttle tuning, and proxy trust. Production additionally needs `MAIL_TRANSPORT_BINDING=smtp` with relay settings and a stable `IDENTIK_SIGNING_JWKS` from your secret manager.

### Tests

```sh
npm run typecheck   # backend + e2e
npm run build       # backend (prebuild regenerates the Prisma client)
npm run test -w e2e # black-box suite: real backend + real PostgreSQL + captured email
npm run verify      # typecheck + build + e2e (what CI runs)
```

### Production deployment

High level — details in [`deploy/README.md`](deploy/README.md):

1. Provision Docker + PostgreSQL 18 + Caddy (or your proxy).
2. Set production env (`DATABASE_URL`, https `IDENTIK_BASE_URL`, SMTP binding, stable signing keys). Never `IDENTIK_DEV_MODE`.
3. Run migrations as a one-off (`migrate`), then start the server.
4. Terminate TLS at the proxy; set `IDENTIK_TRUST_PROXY` to match your proxy layout only.

Pushing a `v*.*.*` tag releases via GitHub Actions: verify, image build + assertion, live smoke test, push to GHCR with provenance attestation, plus a backend tarball on the GitHub Release. The entrypoint supports `server`, `migrate`, and `keygen`.

> [!WARNING]
> One process, one database: no replicas against a single database, no overlapping deploys, no transaction-mode poolers. Restarts are safe (drain ≈ 10 s), not seamless. See [`docs/operator-guide.md`](docs/operator-guide.md).

## How it works

```
Browsers & OIDC clients ──▶ Hosted pages (sign-up / authorize / reset / verify)
Dashboard ─────────────────▶ Management API (/api/...) + OIDC + Health
                                     │ Prisma
                                     ▼
                               PostgreSQL 18
```

- **Backend** (`backend/`, NestJS + TypeScript): one module per domain. The server never migrates — startup refuses a database behind the release and names the command.
- **Tests** (`e2e/`, Vitest): proven over real HTTP against cloned template databases — never storage inspection, never backend mocks.
- **Decisions** live in [`docs/adr/`](docs/adr/); vocabulary in [`CONTEXT.md`](CONTEXT.md), which wins where wording differs.

Unqualified "role" is banned vocabulary: an Administrator Role (Owner/Member, ours) or an application role (theirs — never stored here).

## Scope

In scope: password credentials, single Organization per Instance, OIDC code flows for Web and SPA/Mobile clients. Explicitly deferred: **MFA** (ADR-0017), **federated identities** (ADR-0012), multi-Organization hosted mode, and any authorization engine.

---

Contributing: see [CONTRIBUTING.md](CONTRIBUTING.md). No license file is present in the repository yet.

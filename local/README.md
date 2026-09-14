# IdentiK on Docker Desktop (local development)

A separate local stack that reuses the same production image and the same
explicit-migration contract, but runs development-only behavior
(`IDENTIK_DEV_MODE=1`, captured mail, ephemeral signing keys). It shares
nothing with the production deployment and does not touch `deploy/`.

Everything runs from this directory (`cd local` in the repo).

## What the stack is

| Service  | Image                 | Port on host | Notes |
|----------|-----------------------|--------------|-------|
| `app`    | `identik:local` (built from the repo `Dockerfile`) | `3000` | OIDC/API + captured-mail dev surface |
| `postgres` | `postgres:18.6`     | none (stack-internal) | named volume `identik-local_pgdata`, survives restarts |

There is no proxy: your browser talks to the app directly over
`http://localhost:3000`, so no TLS and no trusting a proxy is needed. Programmatic
configuration (fail-closed) is exactly the same set as production; only the
development-mode allowances differ.

## Start

```sh
cd local
docker compose up -d --build   # first time: builds identik:local, starts postgres + app
docker compose ps              # app (healthy), postgres (healthy)
```

`docker compose up -d` works afterwards without `--build` (the built image is
reused; add `--build` to rebuild when the code changed).

## Apply migrations (explicit, never at app start)

```sh
cd local
docker compose run --rm app migrate
```

Migrations are a one-off, exactly like production. The app refuses to serve a
database behind its release and never auto-migrates.

## Verify

```sh
curl http://localhost:3000/health/live    # {"status":"ok"}
curl http://localhost:3000/health/ready   # {"status":"ok","checks":{"database":{"ok":true},...}}
```

Open http://localhost:3000 in your browser — the OIDC endpoints, the
Administrator API (`/api/...`), and the sign-up/authorize flows are reachable.

## Development-mode mechanics (kept dev-only)

- `IDENTIK_DEV_MODE=1` — enables the ephemeral signing key and the captured
  mail transport; it is refused outside this stack (`deploy/` never sets it).
- `MAIL_TRANSPORT_BINDING=capture` — mail is caught at `/dev/mail` instead of
  being sent. Read it after a sign-up/verification/reset to get the mailbox-proof
  link:
  ```sh
  curl http://localhost:3000/dev/mail
  ```
- `IDENTIK_SIGNING_JWKS` is intentionally unset — ephemeral dev key.
- `IDENTIK_TRUST_PROXY=false` — direct browser access, no proxy headers trusted.

## Data persistence

- PostgreSQL data lives in the named volume `identik-local_pgdata` (visible in
  Docker Desktop under Volumes). It survives `docker compose down`, `stop`, and
  container restarts.
- To delete it deliberately: `docker compose down -v` (or
  `docker volume rm identik-local_pgdata`). Nothing else removes it.

## Other local values

Copy `local/.env.example` to `local/.env` (gitignored) and edit if you want a
different local database password or host port:

```sh
cp local/.env.example local/.env
docker compose up -d   # recreate app so the new values apply
```

## Stop

```sh
cd local
docker compose down    # stack stops; the database volume is kept
```
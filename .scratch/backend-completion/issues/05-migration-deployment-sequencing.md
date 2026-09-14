# 05: Sequence database migrations for deployment

**Type:** grilling
**Status:** resolved
**Blocked by:** 01, 02

## Question

How do schema migrations reach a production database, and what does the Instance do about them?

Facts: migrations are deliberately never applied at boot; startup verifies `_prisma_migrations` plus a core table and otherwise exits with the command to run (`storage/prisma.service.ts:5-6,58-74,97-99`). The documented step is `npx prisma migrate deploy`; the Prisma CLI is a devDependency (`backend/package.json`); the release tarball already ships `prisma/` and `prisma.config.ts` (`.github/workflows/release.yml:60-65`); no Docker artifacts exist.

Settle: who runs migrations (operator step, container entrypoint flag, init container / one-off job); with what database role and privileges (migration role vs runtime role); how concurrent starts and rolling rollouts are serialized (Prisma advisory lock, single migrate step); how the CLI ships in a production install (production dependency vs pinned `npx`); failure behavior (refuse to start vs serve unready); and the exact operator story from the release artifact. Ticket 01 decides whether this is backend work or Dockerization work.

## Answer

**Execution model (Q1).** Migrations are an explicit one-off deploy step, never on server start. Today: `npx prisma@7.10.0 migrate deploy` against the extracted release artifact; Dockerization wraps the same step as a one-off command/job from the image. Documented sequence: migrate, then replace/start the server. A failed migrate leaves the old version serving; an additive migration is safe against the still-running old version until restart. Concurrent attempts are serialized by Prisma's advisory lock — no additional machinery, and no rolling-rollout concern at the supported single-replica topology.

**CLI shipping (Q2).** `prisma` is promoted from devDependency to a production dependency, exact-pinned to 7.10.0 — the same major as the runtime client — so packaged installs migrate without registry access. The tarball's documented `npx prisma@7.10.0 migrate deploy` remains the fallback (there is no `node_modules` in the tarball to promote into).

**Database role (Q3).** One PostgreSQL role for both migrate and runtime, documented as the supported default. A split (privileged `DATABASE_URL` for the migrate command, restricted one for the server) is an operator-side pattern that needs no product support; no second configuration variable is added.

**Boot gate (Q4).** Startup compares the shipped `prisma/migrations` directory against `_prisma_migrations` and refuses to start when the database is behind this release, naming `prisma migrate deploy`; a database ahead of the app (post-migration rollback over additive schema) stays allowed. A missing migrations directory in the runtime artifact is a startup failure. The server still never applies migrations.


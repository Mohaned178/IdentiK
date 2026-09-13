# 08: Run the Instance on PostgreSQL (runtime and tests)

**What to build:** The Instance now runs on PostgreSQL. The data-access facade is implemented over parameterized raw access through the ORM client's PostgreSQL driver adapter; a single database URL is the only persistence configuration; boot performs a schema check and fails fast naming the documented migrate command when the schema is absent; the legacy engine, the boot-time migration runner, and every synchronous access path are deleted; engine-specific SQL is rewritten (JSONB extraction and updates with explicit casts, conflict upserts in place of SQLite's insert-or-ignore/replace, ordering by the new sequence instead of the row identifier). The end-to-end harness provisions a fresh, already-migrated database per Instance by cloning a migrated template, and CI runs the suite against a PostgreSQL 18 service. This completes Stage 1.

**Blocked by:** 01 (Prisma infrastructure, schema, baseline migration), 03 (audit/bootstrap/administrators/invitations), 04 (applications), 05 (identities), 06 (sessions and OIDC), 07 (remaining modules)

**Status:** done

- [x] `DATABASE_URL` is the only persistence configuration, validated at startup; the old state-directory variable is gone
- [x] No migrations run at boot; starting against an unmigrated database exits with a message naming the documented migrate command
- [x] No SQLite engine usage, SQLite-only functions, row-identifier ordering, or boot-time migration code remains
- [x] Each e2e Instance gets a fresh, already-migrated database (clone of a migrated template), dropped on stop; restart scenarios reuse the same database
- [x] CI typechecks, builds, and runs all end-to-end tests against a PostgreSQL 18 service; all 23 files pass
- [x] Race behaviors are unchanged: bootstrap claim, invitation acceptance, sign-up reservation, concurrent enrollment
- [x] Audit reads remain deterministic and newest-first through the sequence column
- [x] Contributions docs cover the PostgreSQL prerequisite, the environment variable, and the migrate command, with a committed example environment file

## Comments

- The facade now lives in `storage/postgres.ts` over the ORM client's
  parameterized raw statements: `?` → `$n` mapping skips single-quoted
  literals, writes report affected rows, reads return rows, and
  `transaction(fn)` binds one interactive transaction. `sqlite.ts`,
  `migrate.ts`, and the prepared-statement half of the `Database` alias are
  deleted. `isUniqueViolation` moved to the facade and recognizes PostgreSQL's
  23505 inside the raw-query error wrapper; Stage 2 converts the typed paths to
  `P2002`.
- Dialect rewrites: bootstrap's `INSERT OR REPLACE`/`IGNORE` became `ON
  CONFLICT` upserts (claim still branches on the returned count), the seven
  audit-detail scrubs became `jsonb_set` over `detail::jsonb` with `to_jsonb`
  casts, the audit identity filter became `detail::jsonb ->> 'identityId'`, and
  audit ordering became `occurred_at DESC, seq DESC`.
- The harness provisions databases, never storage: a migrated template per run
  (one `prisma migrate deploy`), cloned per Instance, forced-dropped on stop;
  `startAt` with a reused key reuses its database, which is how the restart
  durability test keeps working. `IDENTIK_TEST_DATABASE_URL` defaults to the
  conventional local server and is set by CI and the release workflow, both of
  which now run against a PostgreSQL 18 service container.
- Stage 1 acceptance checks 1 and 2 were verified by hand against PostgreSQL
  18: a second `prisma migrate deploy` reports "No pending migrations to
  apply", and startup against an unmigrated database exits naming the command.
  The schema check distinguishes an absent schema from a connectivity failure,
  so a refused connection surfaces as itself rather than as migrate advice.
- Interactive transactions carry explicit generous bounds (10s pool wait, 30s
  timeout) because SQLite's single connection had no transaction deadline;
  without them Prisma's 5s default would be a new failure mode for large
  revoke-all cascades. Stage 2 revisits transaction policy.

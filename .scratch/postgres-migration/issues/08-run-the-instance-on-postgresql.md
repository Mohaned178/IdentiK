# 08: Run the Instance on PostgreSQL (runtime and tests)

**What to build:** The Instance now runs on PostgreSQL. The data-access facade is implemented over parameterized raw access through the ORM client's PostgreSQL driver adapter; a single database URL is the only persistence configuration; boot performs a schema check and fails fast naming the documented migrate command when the schema is absent; the legacy engine, the boot-time migration runner, and every synchronous access path are deleted; engine-specific SQL is rewritten (JSONB extraction and updates with explicit casts, conflict upserts in place of SQLite's insert-or-ignore/replace, ordering by the new sequence instead of the row identifier). The end-to-end harness provisions a fresh, already-migrated database per Instance by cloning a migrated template, and CI runs the suite against a PostgreSQL 18 service. This completes Stage 1.

**Blocked by:** 01 (Prisma infrastructure, schema, baseline migration), 03 (audit/bootstrap/administrators/invitations), 04 (applications), 05 (identities), 06 (sessions and OIDC), 07 (remaining modules)

**Status:** ready-for-agent

- [ ] `DATABASE_URL` is the only persistence configuration, validated at startup; the old state-directory variable is gone
- [ ] No migrations run at boot; starting against an unmigrated database exits with a message naming the documented migrate command
- [ ] No SQLite engine usage, SQLite-only functions, row-identifier ordering, or boot-time migration code remains
- [ ] Each e2e Instance gets a fresh, already-migrated database (clone of a migrated template), dropped on stop; restart scenarios reuse the same database
- [ ] CI typechecks, builds, and runs all end-to-end tests against a PostgreSQL 18 service; all 23 files pass
- [ ] Race behaviors are unchanged: bootstrap claim, invitation acceptance, sign-up reservation, concurrent enrollment
- [ ] Audit reads remain deterministic and newest-first through the sequence column
- [ ] Contributions docs cover the PostgreSQL prerequisite, the environment variable, and the migrate command, with a committed example environment file

# PostgreSQL + Prisma Migration

Status: ready-for-agent

## Problem Statement

The Instance stores everything in a single SQLite file accessed through Node's built-in `node:sqlite`. That locks the platform to one process and a single-writer model, blocks the hosted direction ADR-0024 anticipated, and leaves the data layer as untyped hand-written SQL whose schema, invariants, and transaction discipline exist only in code. The Instance Operator wants the system of record to be a standard PostgreSQL server they already know how to run and back up; the maintainer wants a typed, refactorable data-access layer. Neither is possible while the Instance remains on SQLite.

## Solution

Migrate the Instance's persistence to PostgreSQL 18, configured by a single `DATABASE_URL`, and then adopt Prisma as the data-access layer — in two strictly sequenced stages so that PostgreSQL is proven on its own before the ORM rewrite begins.

- **Stage 1 — engine swap.** A temporary compatibility layer keeps the existing SQL and its meaning while running on PostgreSQL; the app boots only against a migrated database; the full `npm run verify` suite runs against a real PostgreSQL 18 server and all 23 end-to-end behaviors pass. No Prisma query API is used yet.
- **Stage 2 — ORM conversion.** Modules convert incrementally to Prisma models, typed queries, and `$transaction`; unique-violation handling becomes `P2002`; native PostgreSQL types (`boolean`, `timestamptz(3)`, `jsonb`, enums) replace the SQLite-shaped encodings. Raw SQL survives only for JSONB field scrubbing and the dynamic audit query.
- **Finalize.** The compatibility layer is deleted, Prisma is the only data-access path (minus the two documented raw exceptions), and the full suite is green again.

The migration is behavior-preserving. It starts from a fresh database — there is no SQLite data importer — and introduces no repository layer, no new features, and no Dockerization.

## User Stories

1. As an Instance Operator, I want the Instance to store its data in a PostgreSQL server I run, so that persistence is a service my operations team already knows how to back up, monitor, and scale.
2. As an Instance Operator, I want one `DATABASE_URL` to configure persistence, so that deployment configuration stays declarative and secret-friendly.
3. As an Instance Operator, I want a clear startup failure when the schema is not migrated, so that I am told to run `prisma migrate deploy` instead of meeting an opaque query error.
4. As an Instance Operator, I want migrations applied as an explicit deploy step, so that a process restart can never race a schema change.
5. As an Instance Operator, I want the release artifact to carry the schema and migrations, so that I can deploy without cloning the repository.
6. As an Instance Operator provisioning a fresh Instance, I want an empty PostgreSQL database to be brought to a working state by the documented migrate step alone, so that first boot has no manual database work.
7. As a maintainer, I want the engine swap to land first and independently, so that PostgreSQL compatibility is verified before any ORM behavior changes.
8. As a maintainer, I want a temporary compatibility layer that preserves today's query shapes over PostgreSQL, so that call sites change mechanically (async, dialect) and never behaviorally.
9. As a maintainer, I want the compatibility layer deleted at the end, so that exactly one data-access approach remains.
10. As a maintainer, I want Prisma models and typed queries, so that row shapes and relations are checked by the compiler instead of asserted at runtime.
11. As a maintainer, I want multi-statement invariants expressed as Prisma interactive transactions, so that a unit of work always runs on one connection.
12. As a maintainer, I want unique-constraint races expressed as `P2002` handling, so that race arbitration stays explicit and race-free.
13. As a maintainer, I want native PostgreSQL types (`boolean`, `timestamptz(3)`, `jsonb`, enums), so that the schema expresses its own invariants instead of encoding them in integers, strings, and CHECK constraints.
14. As a maintainer, I want raw SQL restricted to operations Prisma cannot express, so that escape hatches stay few, parameterized, and justified in the code.
15. As a maintainer, I want no repository layer introduced, so that the architecture remains services over a single injected data client.
16. As a maintainer, I want deterministic audit ordering backed by a database-generated sequence, so that replacing SQLite's `rowid` does not change the dashboard's newest-first ordering.
17. As a maintainer, I want each e2e file to get a fresh, already-migrated database cheaply, so that isolation and durability testing survive the engine change without slowing the suite.
18. As a maintainer, I want CI to run the full verification against a real PostgreSQL 18 server, so that PostgreSQL behavior is proven on every change.
19. As a maintainer, I want the two-seam testing contract untouched, so that tests still observe only HTTP and captured email.
20. As an Administrator, I want the Bootstrap Ceremony, invitations, sign-in, session management, audit surface, suspension, and anonymization to behave identically on PostgreSQL, so that the migration is invisible in the dashboard.
21. As an End User, I want sign-up, verification, sign-in, password reset, and verified email change to behave identically on PostgreSQL, so that the migration is invisible to me.
22. As an End User, I want my Session to survive an Instance restart against the same database, so that durability is preserved.
23. As an Administrator, I want concurrent invitation acceptance and email reservation to still arbitrate through uniqueness, so that race behavior is unchanged.
24. As an Administrator, I want anonymization to scrub audit detail in place, so that PII destruction is unchanged.
25. As a reviewer, I want ADR-0026 and ADR-0027 to record the database-engine and data-access decisions, so that the reversal of ADR-0024's two clauses is explicit and reasoned.
26. As a reviewer, I want ADR-0024's status to point at its superseding records, so that the decision history stays navigable.
27. As a reviewer, I want review guidance and issue templates to stop stating that storage is SQLite, so that they match reality.
28. As a contributor, I want a documented local PostgreSQL setup and a committed example of the required environment, so that I can run the suite after a single command.
29. As a Release Manager, I want the release workflow to package the migrations and ship the runtime dependencies they imply, so that an operator can migrate the database with the artifact in hand.
30. As a maintainer, I want the Prisma major pinned and its unsupported-feature boundaries documented, so that upgrades cannot silently drop hand-written schema objects.
31. As a maintainer, I want one documented rule for unique-violation handling around transactions, so that PostgreSQL's aborted-transaction behavior is never reintroduced as a bug.
32. As a maintainer, I want the in-memory throttle to remain unchanged, so that this migration does not smuggle in a shared-state decision.

## Implementation Decisions

### Confirmed decisions

- **Staged hybrid.** Stage 1 migrates SQLite → PostgreSQL with a temporary compatibility layer; Stage 2 converts raw SQL → Prisma; Finalize removes the layer.
- **Fresh database.** No SQLite data importer. PostgreSQL 18 is the target engine; `DATABASE_URL` replaces `IDENTIK_STATE_DIR`.
- **Native types land in Stage 2** (`boolean`, `timestamptz(3)`, `jsonb`, Prisma enums). Stage 1 deliberately preserves the current storage shapes so the engine swap is behavior-preserving.
- **No boot-time migrations.** Prisma Migrate replaces the hand-rolled runner; `prisma migrate deploy` is an explicit operator/CI step; the app performs a startup schema check and fails fast with instructions.
- **Two ADRs**: ADR-0026 (PostgreSQL replaces SQLite) and ADR-0027 (Prisma as the data-access layer), each superseding the relevant clause of ADR-0024.
- **No repository layer.** Services keep injecting one data client; the ADR-0024 "repositories" idea is not part of this work.
- **Dockerization deferred.** A locally running PostgreSQL (documented one-liner) and the CI service container are the only infrastructure changes.
- **`CONTEXT.md` unchanged.** This is an implementation change, not a domain-language change.

### Seams

No new seams. Testing stays at the two confirmed seams — the Instance HTTP surface and the outbound email capture — exactly as the MVP spec established. The e2e harness provisions the Instance's PostgreSQL database (create/drop/migrate) but never inspects its contents, so the two-seam contract holds.

### Target architecture (final)

- One NestJS provider, the existing `DATABASE` token, now provides a `PrismaService`: a `PrismaClient` constructed with the `@prisma/adapter-pg` driver adapter over `DATABASE_URL`. It owns connect/disconnect lifecycle and the pool.
- Services inject the client exactly as they inject the database handle today. No repository layer, no per-entity stores.
- Typed Prisma queries cover CRUD, relations, conditional (compare-and-swap) updates, count-based race arbitration, and transactional units of work.
- **Raw SQL survives only for two exception classes:** (1) `jsonb_set` scrubbing of audit detail during anonymization and application deletion, and (2) the dynamic audit list query with its actor join, JSONB identity filter, optional limit, and deterministic ordering. Both go through parameterized Prisma raw calls, never string interpolation of values.
- The temporary compatibility layer from Stage 1 does not exist in the final architecture; its deletion is the Finalize criterion.

### Temporary Stage 1 compatibility layer

- A single storage-layer facade exposes the shape the services already use — prepared-statement-style access with `run/get/all`, an `exec` for DDL, and a `transaction(fn)` that binds one checked-out connection — implemented over Prisma's parameterized raw query methods. It performs `?` → `$n` placeholder mapping with a scanner that skips single-quoted literals, returns `{ rowCount }` from run operations, returns the first row (or `undefined`) from get operations, and normalizes PostgreSQL's `23505` unique violation so the existing uniqueness helper and its four callers keep their behavior.
- The 17 explicit `BEGIN`/`COMMIT`/`ROLLBACK` blocks are rewritten to the facade's `transaction(fn)` because a pooled connection cannot safely span bare `BEGIN` and later statements.
- Stage 1 does not use any Prisma model API. The ORM is not "half adopted"; the facade is a deliberately dumb port.
- This layer is clearly temporary: it is the only file deleted in Finalize, and no service signature may depend on it beyond the existing `Database` type alias.

### Stage 2 conversion order

1. **Foundation**: `PrismaService`/module, the `Database` token re-pointed at it, unique-violation helper switched to `P2002`, generated client wired into build/typecheck.
2. **Audit write path** (a single create) — everything else records through it, so it lands first.
3. **Bootstrap Ceremony** (claim plus organization/administrator/membership/audit in one transaction).
4. **Administrators and invitations** (sign-in, admin sessions, invitation acceptance transaction).
5. **Applications** (register, disable/enable, delete with audit scrub, secrets, redirect URIs).
6. **Identities** (reservation, tokens, password change/reset, verified email change, suspension, anonymization with raw scrubs).
7. **Sessions and OIDC** (session lifecycle, authorization codes, refresh-token rotation and revocation).
8. **Enrollments, settings, account center, identity directory, organization reads** (the remaining reads and simple writes).
9. **Finalize**: delete the facade, keep only the two raw exception classes, full verification.

Each step is independently mergeable and gated on the full e2e suite.

### Schema mapping

Every current table maps to one Prisma model, preserving table and column names (snake_case mapping) so raw exceptions and existing vocabulary stay stable. Stage 1 types preserve current storage shapes; Stage 2 converts to native types. All ids remain application-generated UUID text.

| Table | Stage 1 (legacy fidelity) | Stage 2 (native) |
|---|---|---|
| organizations | id, name, created_at text | created_at `timestamptz(3)` |
| administrators | id, email, name, password_hash, created_at text | created_at `timestamptz(3)`; email unique |
| memberships | role text + CHECK; unique (org, admin) | role enum `AdministratorRole` |
| admin_sessions | token_hash unique; text timestamps | timestamps `timestamptz(3)` |
| audit_events | detail text; occurred_at text; ordering by `seq` (new identity column) | detail `jsonb`; occurred_at `timestamptz(3)`; `seq` identity int stays |
| instance_state | key PK, value text | unchanged |
| identities | email_verified int + CHECK; text timestamps; unique (org, email); email CHECK | email_verified `boolean`; timestamps `timestamptz(3)` |
| identity_tokens | kind text + CHECK; text timestamps | kind enum `IdentityTokenKind`; timestamps `timestamptz(3)` |
| administrator_invitations | role text + CHECK; text timestamps | role enum `AdministratorRole`; timestamps `timestamptz(3)` |
| applications | type text + CHECK; allowed_scopes text default; text timestamps | type enum `ApplicationType`; timestamps `timestamptz(3)` |
| client_secrets | text timestamps | timestamps `timestamptz(3)` |
| redirect_uris | unique (app, uri); text timestamps | timestamps `timestamptz(3)` |
| enrollments | unique (identity, app); text timestamps | timestamps `timestamptz(3)` |
| sessions | text timestamps | timestamps `timestamptz(3)` |
| authorization_codes | text timestamps | timestamps `timestamptz(3)` |
| refresh_tokens | text timestamps; indexes on session/app | timestamps `timestamptz(3)`; indexes preserved |
| organization_settings | key text + CHECK; composite PK (org, key); value text | key enum `OrganizationSettingKey`; `value` stays text (merged in application code) |
| email_change_requests | text timestamps; index on identity | timestamps `timestamptz(3)`; index preserved |
| schema_migrations | deleted; replaced by `_prisma_migrations` | — |

Mapping notes:

- **Relations** follow every foreign key. The `Administrator` model carries several distinct relations (membership, invited-by, created-by on applications/secrets/redirect URIs, revoked-by, settings updated-by), so named relations are required to disambiguate. Child records remain Organization-scoped per ADR-0025; no `ON DELETE` cascades are introduced (cascades stay application-controlled as today).
- **`audit_events.actor` remains a plain column**, not a relation: it is polymorphic (`instance`, `end-user`, or an Administrator id) and has no foreign key. Actor-name resolution stays inside the raw audit query.
- **Composite keys/uniques** map as: memberships (organization, administrator), identities (organization, email), enrollments (identity, application), redirect URIs (application, uri), organization settings (organization, key) primary key.
- **The `seq` identity column is added in the Stage 1 baseline** because PostgreSQL has no `rowid`; the audit read orders by `occurred_at DESC, seq DESC`. The identity field is marked unique to satisfy schema validation and to give the order an index.
- **Hand-written SQL in migrations** (invisible to the Prisma schema): the email normalization guard `email = lower(email)` on administrators, identities, administrator invitations, and email change requests; and, in Stage 1 only, the enum-shaped CHECKs and the `email_verified IN (0,1)` CHECK. The generated baseline is edited with `--create-only` before first application, and the Stage 2 migration explicitly drops the CHECKs it supersedes (a type change would otherwise fail or leave dead constraints). The four email CHECKs remain permanently.
- **`audit_events.detail` binds as JSON**: raw statements in Stage 1 cast between text and `jsonb` (Stage 1 keeps the column as text); Stage 2 makes it `jsonb` and the scrubbing statements operate on `jsonb` natively.
- **Email uniqueness does not rely on an extension**: the values are stored normalized by application code, uniqueness is a plain constraint, and the CHECK is the database-level guard. No `citext`.

### Migration strategy

- Prisma Migrate is the only migration mechanism: one hand-reviewed baseline built from the mapped schema (`--create-only`, then edited), followed by Stage 2 migrations for the native types. The connection URL lives in `prisma.config.ts` (required by current Prisma majors for migrate/introspect).
- `schema_migrations` and the in-app runner are deleted; `_prisma_migrations` is the bookkeeping. The legacy v14 normalization data migration disappears with the squash (fresh database, nothing to fold).
- Migrations are **not** applied at boot. The documented step is `prisma migrate deploy`; CI and the e2e harness use the same command. Startup verifies the schema exists (migration table and a core table) and otherwise exits with a message naming the command to run.
- The release artifact gains the `prisma/` directory (schema and migrations) so an operator can deploy migrations from it. Exact CLI availability in the artifact is an implementation detail; `npx prisma@<pinned> migrate deploy` is the documented fallback.
- Prisma's unsupported-feature workflow is the rule for hand-written SQL: add it inside a migration with `--create-only`, commit the edited migration, and never let a future generated migration silently drop it. Generated migrations are reviewed for destructive operations before merge, especially after Prisma upgrades.

### Transaction strategy

- **Stage 1**: the 17 explicit transaction blocks use the facade's `transaction(fn)`, which checks out one client, commits on success, rolls back on throw, and releases.
- **Stage 2**: the same blocks become `prisma.$transaction(async (tx) => …)`. Any helper that writes inside a unit of work (notably the audit writer) accepts the transaction client as well as the top-level client.
- **The PostgreSQL aborted-transaction rule is load-bearing**: after any failed statement inside a transaction, the transaction is aborted and cannot be continued. Therefore unique-violation arbitration is never caught *inside* an interactive transaction. The patterns are:
  - The Bootstrap Ceremony claim uses a duplicate-skipping bulk insert and branches on the returned count (no error path).
  - Invitation acceptance wraps its statements in `$transaction`; a `P2002` thrown out of the callback rolls the transaction back, and the caller maps it to the same refusal as today.
  - Standalone insert/update arbitration (email reservation on sign-up, enrollment insert, email-change move) catches `P2002` at the statement boundary exactly as the current code catches the SQLite violation; the email-change refusal audit and email are written after the failed statement, outside any transaction, as today.
  - Single-use consumption and token rotation remain compare-and-swap updates whose returned row (or count) decides the winner; they are not exception paths.
- The 17 blocks in scope by owner: bootstrap completion, application register/disable/enable/delete, redirect URI add/remove/update, session revoke cascades, invitation acceptance, identity email-change and anonymization, organization settings upsert (which becomes a single typed upsert and needs no explicit block), and the OIDC revocation paths.
- The current uniqueness helper and its four callers are converted in Stage 2: PostgreSQL `23505` (Stage 1) → Prisma `P2002` (Stage 2), with constraint names available in the error metadata if a site ever needs to distinguish which unique was hit.

### Stage 1 dialect inventory

Behavior-preserving translations required by the engine swap:

- JSON reads: `json_extract(detail, '$.x')` → JSONB path extraction with a text cast (Stage 1) / native operator (Stage 2).
- JSON partial writes: `json_set(detail, '$.x', ?)` → `jsonb_set` with a JSON value cast; seven statements (six in anonymization, one in application deletion).
- Upserts: `INSERT OR REPLACE` → `ON CONFLICT … DO UPDATE`; `INSERT OR IGNORE` → `ON CONFLICT … DO NOTHING` with a row-count branch.
- Row counts: `.changes` → the facade's row count (13 sites).
- Ordering: `ORDER BY e.occurred_at DESC, e.rowid DESC` → `…, e.seq DESC`.
- Placeholders: `?` → `$n`, mapped centrally by the facade.
- Case: `COLLATE NOCASE` disappears; the email normalization invariant plus the new CHECK replace it. Case-sensitive `LIKE` is unchanged in effect (all patterns are lowercase literals).
- Everything already compatible is left alone: `RETURNING`, `ON CONFLICT … DO UPDATE` on organization settings, `LIMIT`, `COALESCE`, existence checks, all CHECK-clause syntax, and INTEGER 0/1 booleans.

### Environment and configuration

- `DATABASE_URL` (required, absolute, validated at startup) replaces `IDENTIK_STATE_DIR`, which has no other consumer and is deleted.
- Local development and tests use a documented `IDENTIK_TEST_DATABASE_URL` for administrative operations (create/drop test databases); it defaults to the conventional local server.
- `.env.example` is committed to document the variables; the application continues to read `process.env` directly (no dotenv layer is introduced), so the example is documentation, not a loader.
- `CONTRIBUTING.md` gains the PostgreSQL prerequisite (documented one-liner), the environment variables, and the migrate command.

### E2E and CI

- The harness provisions databases instead of temp state directories: it creates a uniquely named, already-migrated database per Instance, passes its URL as `DATABASE_URL` to the spawned backend, and drops it on stop (forcefully, so lingering connections cannot block). Reusing a database name across a restart preserves the durability scenario.
- A migrated template database is built once per test run (single `prisma migrate deploy`), and per-Instance databases are cloned from it. This keeps isolation identical to today's fresh state directory while avoiding a migration run per test file.
- The harness uses a plain PostgreSQL admin client for create/drop/clone; it never reads or writes the Instance's tables. This is provisioning, not storage assertion, and the two-seam contract is unchanged.
- CI adds a PostgreSQL 18 service container and passes the admin URL to the suite; the existing job shape (typecheck, build, e2e) is preserved. The release workflow gains the schema/migrations packaging noted above.
- `prisma generate` becomes part of install/build/typecheck so the generated client always exists before compilation.

### Documentation and repository metadata

- ADR-0026 and ADR-0027 are written (drafts in the appendices), and ADR-0024 gains a status note pointing at both.
- Review guidance currently asserting "Storage is SQLite" is updated to describe PostgreSQL + Prisma, the two raw exceptions, the no-`P2002`-inside-transactions rule, and the review requirement for generated migrations containing hand-written schema objects.
- The bug-report template's environment example stops naming SQLite.
- `.gitignore` gains the generated client directory.

## Testing Decisions

- **What makes a good test here**: external behavior only, driven through the two existing seams. A storage engine and an ORM are precisely the kind of implementation detail the seams exist to hide; not one assertion may change because of this migration. The migration's real test is that the entire existing suite, unchanged in intent, passes on PostgreSQL and again after each Stage 2 module conversion.
- **Modules under test**: none individually — the whole Instance remains the unit under test. No unit tests are added; the repository's testing pattern is full-stack black-box e2e.
- **Seam 1 — Instance HTTP surface**: all 23 existing e2e files, including bootstrap, invitations, sign-up/verification/reset, email change, sessions and revocation, OIDC issuance/refresh, suspension, anonymization, audit surface, and the coherence arc. These prove the engine swap and every converted module.
- **Seam 2 — captured email**: unchanged; mailbox-proof flows continue to be driven by delivered mail.
- **Race and ordering scenarios that must stay green**: bootstrap claim under repeated completion, concurrent invitation acceptance, sign-up reservation collisions, concurrent enrollment, single-use token consumption, refresh rotation, and audit ordering (now via `seq`).
- **Durability**: the restart scenario reuses one database across two Instance process lifetimes, proving persistence moved from a file to a server without losing the guarantee.
- **Harness lifecycle** gets its own operational checks: a failed test still drops its database, the template is dropped at suite end, and a missing local PostgreSQL produces a clear failure rather than a timeout.
- **Stage gates** are verification checkpoints, not new tests: Stage 1 is done when `npm run verify` passes against real PostgreSQL; Stage 2 is done when the same suite passes with the facade deleted.
- **Prior art**: the existing e2e suite and harness (the walking skeleton through coherence arc) are the pattern; this spec adds no new style.

## Out of Scope

- A SQLite → PostgreSQL data importer or any migration of existing Instance data (fresh database by decision).
- Dockerization of the application, compose files, deploy orchestration, or a packaged migration container.
- A repository layer or any per-entity data-access abstraction.
- Native type conversion before Stage 2 (Stage 1 intentionally keeps the legacy storage shapes).
- Shared/persistent throttle state; the in-memory throttle is unchanged and the single-process assumption is untouched by this work.
- Hosted multi-tenancy, new features, API changes, domain-model changes, or `CONTEXT.md` edits.
- Unit tests, performance tuning, connection-pool tuning beyond defaults, and Prisma Studio or other developer tooling beyond migration and generation.
- Changing the health endpoint's behavior or adding database health checks.

## Further Notes

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| A missed `await` during the async conversion silently changes behavior | Convert by module with the full e2e suite after each block; review diffs for floating promises; strict TypeScript already on |
| PostgreSQL aborts a transaction after an error and later statements fail | The rule is explicit: never catch unique violations inside a transaction; use skip-duplicates or catch at the statement boundary |
| Hand-written schema objects (CHECKs, expression/partial indexes) are invisible to Prisma and can be dropped by future generated migrations | Migrations are hand-edited via `--create-only`; generated migrations are reviewed for destructive statements; the unsupported-feature workflow is documented in the ADR |
| A Prisma upgrade changes what the migration engine considers drift | Pin one Prisma major; upgrade deliberately with a migration review; keep hand-written SQL minimal and listed |
| Enum evolution (`ALTER TYPE … ADD VALUE`) has transaction and usage constraints | Enums hold closed sets; the only plausible growth is token kinds or setting keys, and each change gets a dedicated migration reviewed by hand |
| Text → `timestamptz` conversion mishandles stored values | Values are UTC ISO strings; migration SQL is reviewed and the suite (expiry, audit windows) proves the conversion |
| `CREATE DATABASE … TEMPLATE` fails or leaks databases | Template has no open connections at clone time; drops are forced and best-effort at teardown; a clear error if the admin server is unreachable |
| The compatibility layer's placeholder mapping misreads SQL | Scanner skips single-quoted literals; existing SQL contains no literal `?`; every mapped statement is exercised by the suite |
| Release artifact ships migrations but no easy way to run them | Include `prisma/` in the artifact and document `npx prisma@<pinned> migrate deploy`; exact CLI packaging decided in implementation |
| The engine swap and ORM rewrite blur together, making failures hard to attribute | Stage gates are hard: Stage 1 is verified green on PostgreSQL before any Stage 2 branch starts |

### Acceptance criteria

**Stage 1 (engine swap; temporary facade present)**

1. `prisma migrate deploy` against an empty PostgreSQL 18 database creates the complete schema; a second run is a no-op.
2. Starting the Instance against an unmigrated database fails fast with a message naming the migrate command; starting against a migrated database serves normally.
3. `npm run verify` passes locally and in CI, with the e2e suite running against a real PostgreSQL 18 server; all 23 e2e files pass.
4. No `node:sqlite` usage, no `IDENTIK_STATE_DIR`, no in-app migration runner, and no `schema_migrations` remain.
5. Race behaviors are unchanged: bootstrap claim, invitation acceptance, sign-up reservation, enrollment.
6. Audit ordering is deterministic and newest-first via the sequence column.
7. Every SQL statement is parameterized; placeholder mapping is centralized, not per-call.
8. The compatibility layer is the only new storage abstraction and is documented as temporary.

**Stage 2 (ORM conversion; facade still present until the end)**

1. Every module except the two documented raw exception classes uses Prisma models, typed queries, and `$transaction`.
2. Unique-violation handling at the four arbitration sites uses `P2002`.
3. The schema and live database use native types: `boolean`, `timestamptz(3)`, `jsonb` audit detail, and enums for role/kind/type/setting key; superseded CHECKs are dropped, the email normalization CHECKs remain.
4. Raw SQL usage is exactly: the JSONB detail scrubbing statements and the dynamic audit list — grep-verifiable and each annotated with why.
5. No repository layer exists.
6. `npm run verify` passes after each module conversion and at the end of the stage.

**Finalize**

1. The compatibility layer is deleted; nothing imports it.
2. Prisma is the primary data-access layer; only the documented raw exceptions remain.
3. ADR-0026 and ADR-0027 are merged; ADR-0024's status points at them; review guidance and the bug template are updated; `CONTEXT.md` is untouched.
4. `npm run verify` passes on the final tree.

### Operator story (unchanged promise, new shape)

An Instance Operator provisions PostgreSQL 18, sets `DATABASE_URL`, runs the documented migrate command from the release artifact, and starts the Instance. Restarts no longer race schema changes. The single-file backup story is knowingly retired; packaging and backup guidance belong to the deferred Dockerization phase or operator documentation.

## Appendix A — ADR-0026 draft

# PostgreSQL replaces SQLite as the Instance database

Status: accepted. Supersedes ADR-0024.

ADR-0024 chose a single SQLite file accessed through `node:sqlite` for a self-hosted first release, and explicitly kept the storage engine swappable for a hosted mode that would demand PostgreSQL. That mode is now the direction of travel, so the Instance's persistence is PostgreSQL, configured by `DATABASE_URL`, and the schema is created by Prisma Migrate rather than at boot. The migration is staged: the engine swap lands first behind a temporary compatibility layer and is verified against the full end-to-end suite, and the SQLite-shaped storage encodings are converted to native PostgreSQL types in a second stage. Self-hosted Operators must now run a PostgreSQL server; packaging, backup, and deployment guidance for that are deferred to the Dockerization phase. Fresh databases only — there is no importer.

**Considered options**: keep SQLite (rejected — blocks the hosted direction and multi-process operation); dual-dialect support (rejected — permanent maintenance for no user benefit); embedded PostgreSQL in WASM (rejected — single-connection execution, wrong shape for a server-backed future).

**Consequences**: a server dependency replaces the single-file install story; migrations become an explicit deploy step with a startup schema check; Operations Guidance currently in ADR-0024 ("a file the Operator backs up") is superseded.

## Appendix B — ADR-0027 draft

# Prisma as the Instance's data-access layer

Status: accepted. Supersedes the no-ORM clause of ADR-0024.

The Instance now reaches PostgreSQL through Prisma: one injected client built on the `pg` driver adapter, typed models and queries, interactive transactions, and `P2002` for unique-constraint arbitration. ADR-0024 deliberately avoided an ORM while the storage engine was a file and the SQL was small; with a server database and a schema of eighteen tables, type-checked models, typed relations, and generated migrations are worth more than textual SQL alone. The adoption is staged after the engine swap so PostgreSQL compatibility is proven independently. Raw SQL remains a first-class, bounded escape hatch — JSONB field scrubbing and the dynamic audit query are not expressible (or not worth expressing) in Prisma; they stay parameterized and annotated. No repository layer is introduced: services keep injecting the single data client. Hand-written schema objects (the email normalization CHECKs) live in migrations that Prisma's schema cannot represent, so generated migrations are reviewed for destructive drift.

**Considered options**: keep plain SQL over `pg` (rejected — no type safety, hand-rolled migrations, and no relation modeling); an ORM later, after the engine swap as a separate decision (deferred, not rejected as a valid sequencing); introducing a repository layer above Prisma (rejected — untested by the two-seam suite and contrary to the current architecture).

**Consequences**: build and tooling gain a generated client and the Prisma CLI/config; migrations are no longer applied by the app; the documented raw-SQL exceptions and the no-`P2002`-inside-interaction rule become review obligations.

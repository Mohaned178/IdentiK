# PostgreSQL replaces SQLite as the Instance database

Status: accepted. Supersedes the storage-engine clause of ADR-0024.

ADR-0024 chose a single SQLite file accessed through `node:sqlite` for a self-hosted first release, and explicitly kept the storage engine swappable for a hosted mode that would demand PostgreSQL. That mode is now the direction of travel, so the Instance's persistence is PostgreSQL, configured by `DATABASE_URL`, and the schema is created by Prisma Migrate rather than at boot. The migration is staged: the engine swap lands first behind a temporary compatibility layer and is verified against the full end-to-end suite, and the SQLite-shaped storage encodings are converted to native PostgreSQL types in a second stage. Self-hosted Operators must now run a PostgreSQL server; packaging, backup, and deployment guidance for that are deferred to the Dockerization phase. Fresh databases only — there is no importer.

**Considered options**: keep SQLite (rejected — blocks the hosted direction and multi-process operation); dual-dialect support (rejected — permanent maintenance for no user benefit); embedded PostgreSQL in WASM (rejected — single-connection execution, wrong shape for a server-backed future).

**Consequences**: a server dependency replaces the single-file install story; migrations become an explicit deploy step with a startup schema check; Operations Guidance currently in ADR-0024 ("a file the Operator backs up") is superseded.

# 01: Prisma infrastructure, schema, and baseline migration

**What to build:** The Instance's complete schema exists as a Prisma schema and can be applied to an empty PostgreSQL 18 database with the documented migrate command. The schema preserves every current table, column, constraint, relation, and index, using the legacy storage shapes for now (text timestamps, integer booleans, string enum columns with CHECK constraints) plus the sequence column that replaces the SQLite row identifier. The release artifact carries the schema and migrations so an operator can deploy them. The application continues to run on SQLite; nothing observable changes.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] `prisma migrate deploy` against an empty PostgreSQL 18 database creates the complete schema, and a second run changes nothing
- [x] Every table, column, primary key, composite unique constraint, foreign key, and index in the current schema is represented, including the new ordering sequence on the audit table
- [x] The baseline migration carries the hand-written constraints Prisma cannot express: the email normalization CHECKs on all four email columns, and the CHECKs behind the legacy boolean and enum shapes
- [x] The ORM client generates cleanly as part of install, build, and typecheck without any application code importing it yet
- [x] `npm run verify` passes unchanged
- [x] The release artifact includes the schema and migrations and declares the runtime dependencies they require

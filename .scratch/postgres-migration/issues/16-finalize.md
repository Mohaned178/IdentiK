# 16: Finalize

**What to build:** The temporary facade and the legacy uniqueness helper are deleted with no remaining imports. Prisma is the only data-access path, minus the two justified raw exception classes — JSONB detail scrubbing and the dynamic audit list — each annotated where it lives. Review guidance and the issue template stop describing SQLite storage, and the full verification suite passes on the final tree.

**Blocked by:** 15 (native PostgreSQL types)

**Status:** done

- [x] The facade and the legacy uniqueness helper are gone, with no remaining imports
- [x] Raw SQL usage is exactly the two documented exception classes and is grep-verifiable
- [x] No repository layer exists
- [x] Review guidance describes PostgreSQL plus the ORM, the raw exceptions, and the no-unique-catch-inside-transactions rule
- [x] The bug report template no longer claims SQLite storage
- [x] `npm run verify` is green

## Comments

One raw-SQL site survives outside the two data-access exception classes: the
startup schema probe in `storage/prisma.service.ts`. `_prisma_migrations` has
no Prisma model, and the startup contract requires the check, so it stays raw,
is annotated in place as infrastructure, and is named in the review guidance.
A `grep -rn '\$queryRaw\|\$executeRaw' backend/src` therefore returns the two
exception classes (7 JSONB scrubs + 1 dynamic audit list) plus that one
documented probe.

The Stage 1 facade's generous interactive-transaction budget (10s wait, 30s
timeout) moves to the client constructor's `transactionOptions`, preserving the
policy for every `$transaction` call without keeping a facade-style wrapper.

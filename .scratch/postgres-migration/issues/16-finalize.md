# 16: Finalize

**What to build:** The temporary facade and the legacy uniqueness helper are deleted with no remaining imports. Prisma is the only data-access path, minus the two justified raw exception classes — JSONB detail scrubbing and the dynamic audit list — each annotated where it lives. Review guidance and the issue template stop describing SQLite storage, and the full verification suite passes on the final tree.

**Blocked by:** 15 (native PostgreSQL types)

**Status:** ready-for-agent

- [ ] The facade and the legacy uniqueness helper are gone, with no remaining imports
- [ ] Raw SQL usage is exactly the two documented exception classes and is grep-verifiable
- [ ] No repository layer exists
- [ ] Review guidance describes PostgreSQL plus the ORM, the raw exceptions, and the no-unique-catch-inside-transactions rule
- [ ] The bug report template no longer claims SQLite storage
- [ ] `npm run verify` is green

# 02: Async data-access facade (expand)

**What to build:** A temporary async data-access contract with the final facade's shape — prepared-style access with single-row and multi-row reads, a DDL exec, affected-row counts, `?` placeholder semantics, and a transaction that binds one connection — implemented over the current SQLite database. Legacy synchronous call styles keep working beside it. No module converts yet; this ticket only makes the new form exist.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] The async contract is defined in one place; implementations are checked against it by the compiler
- [x] A temporary SQLite-backed implementation satisfies the contract while existing synchronous access continues to work
- [x] `transaction(fn)` runs its statements on one connection, commits on success, and rolls back on throw
- [x] Placeholder and affected-row semantics match what the final PostgreSQL facade will provide
- [x] The full end-to-end suite passes unchanged on SQLite

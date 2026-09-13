# 07: Convert the remaining modules to the async contract

**What to build:** Enrollments, organization settings, the Account Center, the identity directory, and the remaining organization reads reach storage exclusively through the async contract. After this ticket no synchronous storage call style remains anywhere, clearing the way for the engine swap.

**Blocked by:** 02 (async data-access facade)

**Status:** done

- [x] No synchronous storage call style remains in the backend
- [x] Every transaction in these modules uses the contract's transaction
- [x] Settings upsert and enrollment semantics are unchanged
- [x] The full end-to-end suite passes unchanged on SQLite

## Comments

- Scope boundary: every module call site now uses the async contract. Only
  `storage/sqlite.ts` (the legacy synchronous half of the facade, plus the
  `isUniqueViolation` classifier the four arbitration sites still import) and
  `storage/migrate.ts` (the boot-time runner) contain engine-specific code; no
  module uses the synchronous `prepare` surface. Ticket 08 replaces the engine
  and keeps feeding the classifier through `23505` normalization; Stage 2
  converts it to `P2002`.
- The settings upsert's explicit `BEGIN`/`COMMIT` block became
  `transaction(fn)` with the transaction client threaded into the audit
  writer. Enrollment race arbitration is unchanged: the unique-violation catch
  stays at the statement boundary, and `allows` remains the token-boundary
  gate, now awaited by the OIDC services.
- Organization settings reads are now awaited on hot paths (Session creation
  and activity touch), so the idle-timeout read yields at a real await where it
  previously ran inline; the effective timeout math is unchanged.

# 14: Convert the remaining modules to typed access

**What to build:** Enrollments, organization settings, the Account Center, the identity directory, and the remaining organization reads use typed models and queries, completing the conversion. Enrollment collisions use the unique-violation error; the settings write becomes a typed upsert.

**Blocked by:** 09 (Prisma client foundation)

**Status:** done

- [x] The remaining modules use typed models and queries; no raw SQL remains in them
- [x] Enrollment collision arbitration uses the ORM's unique-violation error
- [x] The settings write is a typed upsert with unchanged merge behavior
- [x] Every backend module has been converted off the facade
- [x] `npm run verify` is green

## Comments

- Enrollments: the collision path keeps its shape — `find` first, typed
  `create`, and `P2002` caught at the statement boundary with a re-find for
  the lost race. Listing and single views join the Identity through the
  relation include, suspend/unsuspend are `updateMany` calls, and
  `removeAllForApplication` returns the typed `deleteMany` count.
- Organization settings: the write is a typed upsert on the composite key
  with the same merge-over-defaults behavior and the same settings+audit
  transaction; stored reads and the idle-timeout hot path stay one
  composite-key read.
- The Account Center and the identity directory read through typed relations
  with their `created_at, id` orderings; the directory's select deliberately
  excludes the password hash, and the anonymized shell is still displayed by
  its pseudonym.
- Raw SQL outside the two documented exception classes is now gone from every
  module. The facade survives only as the `DataHandle` transaction-handle
  type; Finalize (ticket 16) removes it.
- Discovery during verification: the sign-up timing-uniformity e2e test
  failed after the earlier typed conversion. Measured cause: a caught Prisma
  unique violation costs ~70ms against ~5ms for a successful insert, so
  refusing an existing email through the catch leaked email existence at the
  sign-up boundary (~55-70ms median drift). `insertReservation` now reads
  the handle first and attempts the insert only when it is free, with the
  `P2002` catch kept for lost races; the drift is back to 5-16ms and the test
  passes. Committed separately from this ticket's conversion for review
  clarity.
- Verification: `npm run verify` green (23 files, 221 tests).
- Review round applied: removable type aliases deleted and the upsert's data
  payload hoisted out of its create/update duplication.

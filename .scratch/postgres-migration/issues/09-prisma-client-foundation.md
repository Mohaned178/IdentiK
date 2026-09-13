# 09: Prisma client foundation

**What to build:** The ORM client becomes the Instance's injected data client, constructed on the PostgreSQL driver adapter with lifecycle management. Uniqueness handling learns the ORM's unique-violation error. The audit write path is the first typed conversion, proving the pattern; everything else continues through the temporary facade.

**Blocked by:** 08 (run the Instance on PostgreSQL)

**Status:** done

- [x] The client is provided through the existing data token and disconnects on shutdown
- [x] Uniqueness arbitration recognizes the ORM's unique-constraint error
- [x] Audit writes use typed access; that path has no raw SQL
- [x] The facade still serves unconverted modules; `npm run verify` is green

## Comments

- `PrismaService` (`storage/prisma.service.ts`, the old `database.provider.ts`)
  extends the generated client on the `@prisma/adapter-pg` driver adapter and
  is provided under the `DATABASE` token with `useClass`: the token now hands
  out the client itself. It runs the startup schema check in `onModuleInit`
  and `$disconnect` in `onModuleDestroy`; `main.ts` enables Nest's shutdown
  hooks so SIGTERM/SIGINT actually reach the disconnect instead of leaving it
  nominal.
- The facade did not grow a second object: its raw methods (`run/get/all/`
  `exec/transaction`) now live on `PrismaService` and delegate to
  `PrismaRawAccess` over the same connection. `DataAccess` stays the raw
  contract unconverted modules build against.
- Transactions hand back a `DataHandle` — `Prisma.TransactionClient &
  DataAccess`: the typed models the transaction provides plus the facade,
  assembled by a proxy in `postgres.ts`, so a converted writer and an
  unconverted caller share one unit of work. The intersection excludes pool
  lifecycle methods, so `tx.$disconnect()` cannot type-check on a handle the
  transaction does not own.
- The audit write path is typed first: `recordAuditEvent` creates an
  `AuditEvent` through the client (`storage/audit.ts` holds no SQL), and the
  dynamic audit read stays raw as documented exception two. The two helpers
  that hand their handle to the writer (`issueSecretWith`, `revokeRow`) take
  `DataHandle`; no other module changed behavior.
- `isUniqueViolation` recognizes Prisma's `P2002` alongside the raw `23505`
  (direct or driver-adapter-wrapped) that the four arbitration sites still
  throw until their conversions land.
- Verification: `npm run verify` green (23 files, 221 tests); a typed
  duplicate Administrator write was probed to throw `P2002` and the helper
  returns true; startup against an unmigrated database still exits naming
  `npx prisma migrate deploy`.
- Review round applied before commit: the transaction handle got the
  `DataHandle` type (it no longer masquerades as the full client), the
  placeholder mapper went back to module-private, and shutdown hooks were
  enabled so the disconnect criterion is real.
- Deferred: the duplicated error-shape probe shared by `isUniqueViolation`
  and `isUndefinedTable` stays until Finalize; no site needs the constraint
  name today.

# 09: Prisma client foundation

**What to build:** The ORM client becomes the Instance's injected data client, constructed on the PostgreSQL driver adapter with lifecycle management. Uniqueness handling learns the ORM's unique-violation error. The audit write path is the first typed conversion, proving the pattern; everything else continues through the temporary facade.

**Blocked by:** 08 (run the Instance on PostgreSQL)

**Status:** ready-for-agent

- [ ] The client is provided through the existing data token and disconnects on shutdown
- [ ] Uniqueness arbitration recognizes the ORM's unique-constraint error
- [ ] Audit writes use typed access; that path has no raw SQL
- [ ] The facade still serves unconverted modules; `npm run verify` is green

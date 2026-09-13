# 14: Convert the remaining modules to typed access

**What to build:** Enrollments, organization settings, the Account Center, the identity directory, and the remaining organization reads use typed models and queries, completing the conversion. Enrollment collisions use the unique-violation error; the settings write becomes a typed upsert.

**Blocked by:** 09 (Prisma client foundation)

**Status:** ready-for-agent

- [ ] The remaining modules use typed models and queries; no raw SQL remains in them
- [ ] Enrollment collision arbitration uses the ORM's unique-violation error
- [ ] The settings write is a typed upsert with unchanged merge behavior
- [ ] Every backend module has been converted off the facade
- [ ] `npm run verify` is green

# 10: Convert bootstrap, administrators, and invitations to typed access

**What to build:** The Bootstrap Ceremony, administrator sign-in and sessions, and the invitation flow use typed models and queries. The bootstrap claim becomes a duplicate-skipping bulk insert that branches on the returned count, and invitation acceptance runs as an interactive transaction whose unique violation is caught outside it — never inside — mapping to the existing refusal.

**Blocked by:** 09 (Prisma client foundation)

**Status:** ready-for-agent

- [ ] These modules use typed models and queries; no raw SQL remains in them
- [ ] The bootstrap claim arbitrates through the duplicate-skipping insert's count
- [ ] Invitation acceptance is transactional, with the unique violation caught at the transaction boundary
- [ ] No repository layer is introduced
- [ ] `npm run verify` is green

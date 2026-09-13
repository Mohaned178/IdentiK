# 12: Convert identities to typed access

**What to build:** Identity reservation, mailbox-proof tokens, password change and reset, verified email change, suspension, and anonymization use typed models and queries. Reservation collisions and email-change moves arbitrate through the unique-violation error caught at the statement boundary — outside any transaction. The anonymization audit scrubs remain parameterized raw SQL, annotated.

**Blocked by:** 09 (Prisma client foundation)

**Status:** ready-for-agent

- [ ] The identities module uses typed models and queries except for the documented audit-detail scrubs
- [ ] Reservation and email-change race arbitration use the ORM's unique-violation error at the statement boundary
- [ ] No unique violation is caught inside an interactive transaction
- [ ] Raw scrubs are parameterized and annotated
- [ ] `npm run verify` is green

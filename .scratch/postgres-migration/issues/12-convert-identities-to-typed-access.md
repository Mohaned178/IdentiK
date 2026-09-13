# 12: Convert identities to typed access

**What to build:** Identity reservation, mailbox-proof tokens, password change and reset, verified email change, suspension, and anonymization use typed models and queries. Reservation collisions and email-change moves arbitrate through the unique-violation error caught at the statement boundary — outside any transaction. The anonymization audit scrubs remain parameterized raw SQL, annotated.

**Blocked by:** 09 (Prisma client foundation)

**Status:** done

- [x] The identities module uses typed models and queries except for the documented audit-detail scrubs
- [x] Reservation and email-change race arbitration use the ORM's unique-violation error at the statement boundary
- [x] No unique violation is caught inside an interactive transaction
- [x] Raw scrubs are parameterized and annotated
- [x] `npm run verify` is green

## Comments

- `identities.service.ts` is typed throughout: the compound-key credential
  lookup, reservation insert, token issuance and consumption, reset/change
  password writes, email-change request lifecycle, suspension levers,
  hosted-organization read, and the anonymization unit of work. The only raw
  statements left are the six `jsonb_set` audit scrubs, parameterized and
  annotated as the deliberate ADR-0027 exception.
- Race arbitration is where the spec demands it: reservation insert and the
  email-change move catch `isUniqueViolation` (now `P2002`) at the statement
  boundary, outside any transaction; the anonymization transaction catches
  nothing. Token single-use keeps its guarded count as the arbiter —
  `consumeToken` and the email-change claim now claim first and read the row
  back, which preserves expiry, kind, and single-use semantics while giving
  typed rows.
- Identity reads are deliberately narrow: `IDENTITY_SUMMARY_SELECT` never
  fetches `password_hash`, so the Administrator state levers and
  mailbox-proof flows cannot carry a credential (ADR-0008). The
  `identityGate` shared with the token and Session paths now speaks the typed
  field names; those two call sites map from their still-raw rows until
  ticket 13 converts them.
- `identity-directory.service.ts` deliberately stays raw until ticket 14,
  matching the spec's Stage 2 order (directory reads are step 8).
- Verification: `npm run verify` green (23 files, 221 tests), including
  sign-up/verification, reset, verified email change, suspension,
  anonymization, and account center.
- Review round applied: the first pass widened reads to the full model, which
  pulled `password_hash` into paths that must never hold it — fixed with the
  explicit non-credential select; and `verifyEmailChange`'s pre-read no
  longer duplicates guards the claim already enforces.

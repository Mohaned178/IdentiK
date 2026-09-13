# 10: Convert bootstrap, administrators, and invitations to typed access

**What to build:** The Bootstrap Ceremony, administrator sign-in and sessions, and the invitation flow use typed models and queries. The bootstrap claim becomes a duplicate-skipping bulk insert that branches on the returned count, and invitation acceptance runs as an interactive transaction whose unique violation is caught outside it — never inside — mapping to the existing refusal.

**Blocked by:** 09 (Prisma client foundation)

**Status:** done

- [x] These modules use typed models and queries; no raw SQL remains in them
- [x] The bootstrap claim arbitrates through the duplicate-skipping insert's count
- [x] Invitation acceptance is transactional, with the unique violation caught at the transaction boundary
- [x] No repository layer is introduced
- [x] `npm run verify` is green

## Comments

- Bootstrap: `instanceState` reads and the armed-window upsert are typed; the
  completion claim is `createMany({ skipDuplicates: true })` branching on the
  returned `count !== 1`, so the arbitration has no error path and the
  aborted-transaction rule never applies. The Organization, Administrator,
  Membership, and audit writes inside the unit of work are typed creates on
  `tx`. The `instance_state` keys and the completion value are module
  constants, so the two ceremony rows cannot drift by typo.
- Administrators: sign-in resolves the Administrator by unique email, the
  Membership through its Organization relation, and creates the
  `admin_session` typed; `resolveSession` reads by the unique token hash with
  the membership/organization include; `signOut` is an `updateMany` so a
  missing session stays a no-op like the old UPDATE. The failed-sign-in audit
  finds the Organization through the Membership relation filter and falls
  back to the earliest Organization exactly as before.
- Invitations: issuance and the pre-checks are typed; `findByToken` uses a
  shared include plus `Prisma.AdministratorInvitationGetPayload` for the
  Organization name, so the row shape is compiler-checked. Acceptance keeps
  its guarded single-use claim as an `updateMany` whose count decides the
  winner, and `isUniqueViolation` (now `P2002`) is still caught around the
  transaction — never inside, where PostgreSQL would have aborted it.
  Expiry-audit-once keeps its guarded update and count branch.
- `organization.controller.ts` is typed too: it belongs to the
  administrators module and held the module's last raw read.
- No repository layer: the services still inject the one `DATABASE` handle.
- Verification: `npm run verify` green (23 files, 221 tests), including the
  bootstrap concurrency and invitation race scenarios.
- Review round applied: the claim comment no longer inverts the
  insert-versus-skip semantics, locals speak the glossary (`membership`,
  `fallbackOrganization`), the duplicated invitee-existence probe became
  `administratorExists`, and the `instance_state` keys became constants.

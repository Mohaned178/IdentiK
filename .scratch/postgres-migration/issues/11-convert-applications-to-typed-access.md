# 11: Convert applications to typed access

**What to build:** Application registration, Client Secrets, redirect URIs, disable/enable, and deletion use typed models and queries, including typed relation reads. The audit-detail scrub during deletion remains parameterized raw SQL, annotated with why it cannot be expressed as a typed update.

**Blocked by:** 09 (Prisma client foundation)

**Status:** done

- [x] The applications module uses typed models and queries except for the documented audit-detail scrub
- [x] The raw scrub is parameterized and carries a comment naming it as a deliberate exception
- [x] Redirect URI, secret issuance/revocation, and disable/delete semantics are unchanged
- [x] `npm run verify` is green

## Comments

- The module is typed end to end: registration creates inside its unit of
  work, the first Web secret is minted through the same typed path, listing
  and views read the three models with their `created_at, id` orderings,
  disable/enable are guarded `updateMany` calls branching on `count`, and
  deletion revokes secrets with a typed `updateMany` whose count feeds the
  audit detail.
- Relation reads are typed where the old joins were:
  `findForAuthorization` uses a single `findUnique` with the Organization
  name and the ordered redirect URI list included; `findClient` selects the
  token boundary's fields; `verifyClientSecret` loads the active hashes and
  keeps the constant-time comparison.
- The delete scrub remains the module's only raw statement, now annotated as
  the deliberate ADR-0027 exception it is (parameterized; `jsonb_set` cannot
  be expressed as a typed update). The other writes converted to typed
  `updateMany`/`deleteMany`/`create` while keeping their guarded counts.
- One faithful-to-intent deviation: Prisma cannot express
  `disabled_at = COALESCE(disabled_at, now)`, so deletion uses the
  `disabledAt` read a moment earlier. Only a concurrent enable between the
  read and the transaction could see a different timestamp, and the surface
  exposes state, not the timestamp — the comment records the trade.
- Verification: `npm run verify` green (23 files, 221 tests), including
  registration, lifecycle, redirect URI, scope, token issuance, and
  authorization files.
- Review round applied: `updateRedirectUri` switched from `update` to
  `updateMany` so a concurrently removed row keeps the old statement's
  silent no-op instead of failing the transaction and rolling back its
  audit event.

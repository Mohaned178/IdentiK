# 06: Convert sessions and OIDC to the async contract

**What to build:** Session creation, resolution, and revocation, plus authorization-code issuance/consumption and refresh-token rotation/revocation, reach storage exclusively through the async contract. Behavior is unchanged; the Instance still runs on SQLite.

**Blocked by:** 02 (async data-access facade)

**Status:** done

- [x] Sessions and the OIDC modules use only the async contract for storage; no synchronous statements remain
- [x] Every transaction in these modules uses the contract's transaction
- [x] Single-use consumption and refresh rotation arbitration are unchanged
- [x] The full end-to-end suite passes unchanged on SQLite

## Comments

- Scope boundary: the two explicit `BEGIN` blocks in `sessions.service.ts` (single
  revoke, revoke-many cascade) became the contract's `transaction(fn)`; the OIDC
  services had none. Refresh-token rotation, code consumption, and lineage
  revocation stay compare-and-swap statements whose row count decides the winner.
- Session resolution is now awaited by its consumers, so the ripple touched call
  sites outside the two modules: `EndUserSessionGuard.canActivate` is async, the
  Account Center's revoke/sign-out became async handlers, and the identity and
  application controllers await the now-async directory detail and enrollment
  suspension. `identity-directory.service.ts` and `enrollments.service.ts` keep
  their own synchronous storage until ticket 07, which names them.
- Review finding carried forward (Stage 2): `TokenService.mint` re-checks the
  Session, Enrollment, and Application before inserting a refresh token, but the
  async contract turns the formerly uninterrupted SQLite section into awaited
  steps. The check-then-insert window is no longer atomic off SQLite; closing it
  needs a conditional insert or a row lock in the final data-access conversion.
  The end-to-end suite cannot observe the difference on the SQLite facade, so
  this is recorded rather than fixed here.

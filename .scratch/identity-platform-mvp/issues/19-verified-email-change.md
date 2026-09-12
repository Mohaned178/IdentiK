# 19: Account Center — verified email change

**What to build:** The End User's email change flow (ADR-0008's forced consequence). The End User requests a change to a new address in the Account Center; verification mail goes to the *new* address; the change takes effect only once that address is verified — until then the old handle stays. The new email must be unique within the Organization (ADR-0005); a claimed-but-unverified new address follows Unverified Reservation semantics. Every step is an audit event.

**Blocked by:** 03 (verification machinery + uniqueness exist), 11 (Account Center exists).

**Status:** done

- [x] The End User can request an email change to a new address from the Account Center
- [x] The verification email is delivered to the new address (captured in tests); the old handle remains active until verification
- [x] The change takes effect only on verified proof of the new mailbox — never before
- [x] A new address already claimed within the Organization is refused, with uniform messaging
- [x] Verification links are single-use and expire; an abandoned change leaves the Identity untouched
- [x] Email change requests and completions are audit events
- [x] Black-box tests drive the arc over HTTP + captured email only

## Comments

Implementation notes:

- Migration 12 adds `email_change_requests`: a single-use, expiring, verifiable-only token bound to the Identity, its Organization, and the requested address (stored normalized/`COLLATE NOCASE`, since the address must be unique whether or not it is verified). The Identity's `email` column is untouched until the token is consumed, so an abandoned request leaves the handle exactly as it was.
- `IdentitiesService.requestEmailChange` checks the new address against three claimants — the Identity's own handle, any existing Identity (verified or inert Unverified Reservation, ADR-0011), and another Identity's live request — and on refusal audits `identity.email_change.refused` and mails the requested address a notice, mirroring sign-up's "the reason reaches the mailbox, not the HTTP layer" uniformity (ADR-0005). On success it supersedes any earlier pending request (one change pending at a time), inserts the token, audits `identity.email_change.requested`, and sends the link to the new address.
- `IdentitiesService.verifyEmailChange` consumes the token atomically first (single-use), then moves the email with the UNIQUE `(organization_id, email)` constraint as the race-free arbiter; a lost race is a refusal, and the token stays spent. Completion audits `identity.email_change.completed` with the new address and the previous one.
- API: `POST /api/account-center/email` (End-User Session guard) returns a uniform `202 { status: 'check-your-mailbox' }` whether the address is free or claimed. The Account Center view gains `pendingEmail`. The click lives on the public hosted routes `GET /api/end-users/change-email` → `302 /end-users/change-email/result?outcome=changed|invalid`, and the result page is branded like the other hosted pages.
- Anonymization (ADR-0007) now deletes pending email-change requests and pseudonymizes the `newEmail`/`previousEmail`/`email` fields in `identity.email_change.*` audit events, so no address survives deletion.
- No password is required to request the change: the new mailbox proof is the authorization (ADR-0008), and the old handle stays live until it is given.
- Tests: `e2e/src/verified-email-change.test.ts` (8 tests, HTTP + captured email only) covers the auth gate, delivery to the new address with the old handle still authenticating, effect only on proof, single-use links, uniform refusal of a verified address and of an inert Unverified Reservation, audit events, and token expiry leaving the Identity untouched. Full suite: 196 tests across 20 files.

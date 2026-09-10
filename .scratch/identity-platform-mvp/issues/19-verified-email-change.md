# 19: Account Center — verified email change

**What to build:** The End User's email change flow (ADR-0008's forced consequence). The End User requests a change to a new address in the Account Center; verification mail goes to the *new* address; the change takes effect only once that address is verified — until then the old handle stays. The new email must be unique within the Organization (ADR-0005); a claimed-but-unverified new address follows Unverified Reservation semantics. Every step is an audit event.

**Blocked by:** 03 (verification machinery + uniqueness exist), 11 (Account Center exists).

**Status:** ready-for-agent

- [ ] The End User can request an email change to a new address from the Account Center
- [ ] The verification email is delivered to the new address (captured in tests); the old handle remains active until verification
- [ ] The change takes effect only on verified proof of the new mailbox — never before
- [ ] A new address already claimed within the Organization is refused, with uniform messaging
- [ ] Verification links are single-use and expire; an abandoned change leaves the Identity untouched
- [ ] Email change requests and completions are audit events
- [ ] Black-box tests drive the arc over HTTP + captured email only

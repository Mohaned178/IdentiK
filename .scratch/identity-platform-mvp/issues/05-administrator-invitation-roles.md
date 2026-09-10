# 05: Administrator membership — invitation + Owner/Member roles

**What to build:** The platform's own membership lifecycle (ADR-0021), obeying the rules it sells. An Owner invites an Administrator by email; the invitee receives a link and sets their own password — the inviter never chooses a credential (ADR-0008 applied to our own population). Invitation links expire. Invited Administrators sign in via the dedicated Administrator sign-in and receive a Membership scoped to the Organization with a role: Owner or Member. Invitation is Owner-only, and destructive settings are reserved to Owners (ADR-0016); this ticket enforces the role distinction at the Management API for the actions that exist so far (invitation itself). There is no self-serve path to administration. Everything is audit-logged.

**Blocked by:** 02 (Administrator population, dedicated sign-in, and audit store exist).

**Status:** ready-for-agent

- [ ] An Owner can invite an Administrator by email; the invitation email is delivered via the outbound mail boundary (captured in tests)
- [ ] The invitee sets their own password through the invitation link; the inviter never sees or sets it
- [ ] Invitation links expire and are single-use
- [ ] The invited Administrator signs in via the dedicated Administrator sign-in and receives a Membership scoped to the Organization with their role
- [ ] Invitation creation is Owner-only: a Member attempting to invite is refused by the Management API
- [ ] The Owner/Member role distinction exists on the Membership record and is enforced at the Management API for the actions in scope of this ticket
- [ ] No self-serve path to administration exists anywhere on the HTTP surface
- [ ] Invitation issuance, acceptance, and expiry are audit events
- [ ] Black-box tests cover the full invitation arc and the role-based refusal over HTTP only

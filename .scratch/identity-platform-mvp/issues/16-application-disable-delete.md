# 16: Application disable and delete

**What to build:** The Application lifecycle past "registered" (ADR-0007). Disable is reversible pause: new authentication through the Application is blocked and all refresh tokens minted via its flows are revoked immediately, while Sessions (which belong to Identities, not Applications) survive. Delete is Owner-only and irreversible: Enrollments removed, credentials revoked, audit pseudonymized — and orphaned Identities survive, because Identities belong to the Organization, not the Application (ADR-0004). Orphan hygiene is an Organization concern; deletion silently cleaning Identities would be arbitrary and cruel (Mohamed survives because he also used CodeBoard; his colleague shouldn't die because he didn't).

**Blocked by:** 10 (refresh tokens minted via Application flows exist to revoke), 12 (dashboard views where the actions live).

**Status:** ready-for-agent

- [ ] Disabling an Application blocks new authentication through it, immediately
- [ ] Disable revokes all refresh tokens minted via that Application's flows, immediately; Sessions survive
- [ ] Disabling is reversible: re-enable restores authentication for non-suspended Identities
- [ ] Deleting an Application removes its Enrollments and revokes its credentials
- [ ] Deleted-Application audit history survives pseudonymously
- [ ] Identities survive deletion — including those with no other Enrollments (orphands stay in the Organization's Identity list)
- [ ] Deletion is Owner-only at the Management API; disable is Administrator-accessible
- [ ] Disable and delete are audit events; delete's confirmation states irreversibility
- [ ] Black-box tests verify token revocation, orphan survival, and Owner-only enforcement over HTTP only

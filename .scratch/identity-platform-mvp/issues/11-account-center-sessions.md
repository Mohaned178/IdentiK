# 11: Account Center — Session visibility, revocation, sign-out, connected Applications

**What to build:** The End-User self-service surface (ADR-0018): a platform-hosted Account Center. The End User sees their active Sessions — the signed-in devices, with recognizable device metadata (device, time, last-seen) — and can revoke any one of them: the SSO cookie dies and all descendant refresh tokens are revoked immediately (ADR-0013). Sign-out is revocation of the current Session, nothing more mystical; Applications lose the user as their tokens validate. Connected Applications lists the End User's Enrollments, informational only (ADR-0014). The Account Center is linked from Applications; they never embed it.

**Blocked by:** 09 (Sessions exist with their parent-child token structure), 10 (refresh tokens as Session children to revoke).

**Status:** ready-for-agent

- [ ] The Account Center is a platform-hosted surface an authenticated End User can reach
- [ ] Active Sessions are listed with recognizable device metadata (device, time, last-seen) so a non-expert can identify them
- [ ] Revoking a Session kills its SSO cookie and all descendant refresh tokens immediately; a rotated refresh attempt from that lineage is refused
- [ ] Sign-out revokes the current Session
- [ ] Connected Applications shows the End User's Enrollments, informational only — no consent or un-enroll action for End Users
- [ ] Session revocation events are audit events
- [ ] Black-box tests verify revocation observable from outside: cookie invalid, refresh lineage dead, over HTTP only

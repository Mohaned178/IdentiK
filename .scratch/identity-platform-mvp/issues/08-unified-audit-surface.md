# 08: Unified audit surface in the dashboard

**What to build:** The dashboard's viewer for the audit store born in ticket 02. One surface, first-class: every security-relevant event recorded so far — bootstrap, invitations, credential issuance and revocation, redirect URI changes — is visible with who/what/when, filterable enough to answer "who added that URI, when?" in seconds. Later tickets (suspension, anonymization, application lifecycle, throttling failures) record into this surface as acceptance criteria; this ticket makes the accumulated record observable to Administrators. The viewer consumes the Management API like every other dashboard screen.

**Blocked by:** 05, 06, 07 (enough event kinds exist for the surface to be real rather than a bootstrap-only stub).

**Status:** ready-for-agent

- [ ] All audit events recorded by tickets 02–07 are visible in one dashboard surface with who/what/when
- [ ] Events are filterable by actor, event kind, and time range
- [ ] Credential and redirect-URI events are present with the same prominence as suspensions will be (one unified surface, no category buried)
- [ ] Members can view the audit surface; visibility is not Owner-only
- [ ] The viewer consumes the Management API (no dashboard-only back door)
- [ ] Black-box tests assert event presence and metadata over HTTP only

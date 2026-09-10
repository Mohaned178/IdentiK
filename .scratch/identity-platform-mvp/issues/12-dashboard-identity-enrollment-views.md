# 12: Dashboard — Identity and Enrollment views

**What to build:** The Administrator's window into the Organization's people (spec stories 34–35). The Identity list shows every Identity with authentication state; the Identity detail page shows email, verification state, Enrollments, active Sessions, and recent authentication activity — everything security-relevant per ADR-0008, and nothing that authenticates. The per-Application view is formally Enrollments filtered to that Application: "Zotac's users" is a real list. Management levers arrive in ticket 13; this ticket is visibility, consumed via the Management API.

**Blocked by:** 08 (audit surface exists; recent activity reads from it), 09 (Enrollments and Sessions exist as viewable records).

**Status:** ready-for-agent

- [ ] The Identity list shows all Identities of the Organization with their authentication state
- [ ] The Identity detail page shows email, verification state, Enrollments, active Sessions, and recent authentication activity
- [ ] No screen exposes or permits setting anything that authenticates — passwords are invisible and unsettable
- [ ] The per-Application view lists Enrollments filtered to that Application
- [ ] Unverified reservations are visible and clearly flagged as inert
- [ ] Anonymized Identities (once ticket 15 lands) will display pseudonymously — the view degrades gracefully for them
- [ ] Views consume the Management API (no dashboard-only back door)
- [ ] Black-box tests assert view contents over HTTP only

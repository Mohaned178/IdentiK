# 18: Organization settings — branding, password policy, session timeout

**What to build:** The Organization-scoped half of the settings boundary (ADR-0022). Owners edit, in the dashboard via the Management API, all audit-logged: branding (name, logo, colors) applied to the hosted authentication pages and Account Center; per-Organization password policy (length/complexity floors) enforced at sign-up and password change; session timeout policy (idle expiry — Sessions lapse after the Organization's configured idle window). Instance-scoped trust fabric (SMTP, signing keys) deliberately remains out-of-band deployment configuration and out of this ticket's reach — a dashboard actor can never touch it.

**Blocked by:** 03 (sign-up exists for policy enforcement), 11 (Sessions exist for timeout to act on).

**Status:** ready-for-agent

- [ ] Owners can edit Organization branding; hosted pages and Account Center render it
- [ ] Per-Organization password policy is enforced at sign-up and password change; weaker passwords are refused
- [ ] Session timeout policy lapses idle Sessions; activity refreshes the window
- [ ] All three settings are Owner-editable, Member-visible, and every change is an audit event
- [ ] No Organization-scoped setting can reach instance-scoped trust fabric (SMTP, signing keys) — the boundary is enforced at the Management API
- [ ] Black-box tests verify policy enforcement and branded rendering over HTTP only

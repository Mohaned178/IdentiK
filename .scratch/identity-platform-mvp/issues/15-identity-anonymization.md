# 15: Identity anonymization — deletion semantics

**What to build:** What "delete user" really means here (ADR-0007). Anonymizing an Identity destroys PII irreversibly — email, credentials, Sessions, Enrollments all revoked — while audit history survives against a pseudonymous shell ("deleted identity #4a91"), so the platform can still answer "who signed in from that IP last Tuesday?" The email becomes immediately reusable by a fresh, unlinked Identity that inherits nothing. The dashboard's confirmation UX states the irreversibility plainly. No recovery path exists, by design.

**Blocked by:** 13 (the revocation machinery exists; anonymization is the irreversible sibling of suspension).

**Status:** ready-for-agent

- [ ] Anonymizing an Identity destroys its email, credentials, Sessions, and Enrollments irreversibly
- [ ] Audit history referencing the Identity survives against a pseudonymous shell — events remain answerable
- [ ] The anonymized email is immediately reusable by a fresh signup, creating a new unlinked Identity that inherits nothing (no sessions, no enrollments, no history)
- [ ] The new Identity's audit trail starts clean; the old trail stays pseudonymously attributed
- [ ] No code path can reverse or "restore" an anonymized Identity
- [ ] The dashboard confirmation states irreversibility plainly before the action
- [ ] Anonymization is an audit event (perpetrator + when; target recorded pseudonymously)
- [ ] Black-box tests cover the full arc over HTTP only, including email reuse and audit survival

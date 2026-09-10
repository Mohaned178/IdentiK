# 06: Application registration + Client credential lifecycle

**What to build:** Owners register Applications in the dashboard (ADR-0009). Registration captures name and type — Web Application (confidential) or SPA/Mobile Application (public). Every Application receives a Client ID: public, permanent, never rotated. A Web Application additionally receives a Client Secret shown exactly once at generation, stored verifiable-only; multiple concurrent labeled, timestamped secrets can coexist with individual revocation, enabling zero-downtime rotation (ADR-0010). A SPA/Mobile Application is never issued a Client Secret under any circumstance — not at registration, not later. Destructive actions (secret revocation) are Owner-only. Registration and all credential events are audit events recorded into the unified surface. The dashboard and the Management API both expose the full lifecycle — the dashboard consumes the same API everything else does (ADR-0019).

**Blocked by:** 05 (Owner/Member roles enforced at the Management API gate destructive actions).

**Status:** ready-for-agent

- [ ] An Owner can register an Application with a name and type (Web or SPA/Mobile) in the dashboard
- [ ] Every Application receives a Client ID that is public, permanent, and never rotated
- [ ] A Web Application receives a Client Secret displayed exactly once at generation
- [ ] The secret cannot be viewed again by anyone, including Owners — stored verifiable-only
- [ ] Multiple concurrent secrets are supported: generate a second labeled secret, both authenticate, revoke one individually without affecting the other
- [ ] Secrets carry labels and creation timestamps, visible in the dashboard
- [ ] A SPA/Mobile Application is never issued a Client Secret — at registration or through any later API path
- [ ] Secret generation and revocation are Owner-only actions at the Management API
- [ ] Application registration, credential issuance, and revocation are audit events
- [ ] The dashboard performs all of the above through the Management API (no dashboard-only back door)
- [ ] Black-box tests cover the credential lifecycle arc over HTTP only, including the public-client-never-gets-a-secret rule

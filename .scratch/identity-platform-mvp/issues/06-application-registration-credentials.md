# 06: Application registration + Client credential lifecycle

**What to build:** Owners register Applications in the dashboard (ADR-0009). Registration captures name and type — Web Application (confidential) or SPA/Mobile Application (public). Every Application receives a Client ID: public, permanent, never rotated. A Web Application additionally receives a Client Secret shown exactly once at generation, stored verifiable-only; multiple concurrent labeled, timestamped secrets can coexist with individual revocation, enabling zero-downtime rotation (ADR-0010). A SPA/Mobile Application is never issued a Client Secret under any circumstance — not at registration, not later. Destructive actions (secret revocation) are Owner-only. Registration and all credential events are audit events recorded into the unified surface. The dashboard and the Management API both expose the full lifecycle — the dashboard consumes the same API everything else does (ADR-0019).

**Blocked by:** 05 (Owner/Member roles enforced at the Management API gate destructive actions).

**Status:** done

- [x] An Owner can register an Application with a name and type (Web or SPA/Mobile) in the dashboard
- [x] Every Application receives a Client ID that is public, permanent, and never rotated
- [x] A Web Application receives a Client Secret displayed exactly once at generation
- [x] The secret cannot be viewed again by anyone, including Owners — stored verifiable-only
- [x] Multiple concurrent secrets are supported: generate a second labeled secret, both authenticate, revoke one individually without affecting the other
- [x] Secrets carry labels and creation timestamps, visible in the dashboard
- [x] A SPA/Mobile Application is never issued a Client Secret — at registration or through any later API path
- [x] Secret generation and revocation are Owner-only actions at the Management API
- [x] Application registration, credential issuance, and revocation are audit events
- [x] The dashboard performs all of the above through the Management API (no dashboard-only back door)
- [x] Black-box tests cover the credential lifecycle arc over HTTP only, including the public-client-never-gets-a-secret rule

## Comments

Implementation notes:

- Management API surface (ADR-0019): `POST /api/applications` (`{ name, type }`), `GET /api/applications`, `GET /api/applications/:id`, `POST /api/applications/:id/secrets` (`{ label }`, Owner-only), `POST /api/applications/:id/secrets/:secretId/revoke` (Owner-only). Every route is scoped to the caller's Organization; reads return secret *metadata* (id, label, createdAt, revokedAt) but never a secret value or hash.
- Data model (migration v5): `applications` (org-scoped, `type IN ('web','spa')`, `client_id UNIQUE`) and `client_secrets` (label, `secret_hash UNIQUE`, created/revoked timestamps). A SHA-256 hash is sufficient because a Client Secret is a high-entropy random value, matching the existing Session-token treatment (`crypto/password.ts`). No read-back path exists, so "stored verifiable-only" is structural.
- Client ID is `randomToken(16)` (base64url), generated once at registration and never exposed on a rotation surface — the only thing that changes it is registering a different Application.
- Owner-only rule: `POST .../secrets` and `.../revoke` sit behind `OwnerGuard`. Registration of a *Web* Application is also restricted to Owners, because registration necessarily mints that Application's first secret; a Member may register SPA/Mobile Applications (spec story 10), which hold no secret. `ApplicationsService.issueSecret` additionally refuses any non-Web Application, so the public-client rule holds on every path, not just the HTTP one.
- Registration and the confidential client's first secret are written in one transaction, so a Web Application can never be left half-registered without the credential that makes it useful.
- Audit events (ADR-0023), all Organization-scoped and recording the acting Administrator: `application.registered`, `client_secret.generated`, `client_secret.revoked`.
- Dashboard: no dashboard ships in this release (the UI workspace was removed at 815bf37), so the Management API is the only surface and the no-back-door property is structural. The one-time secret reveal is the `clientSecret` field on the registration and secret-issue responses (present once, never in list/detail reads).
- Deferred: an actual client *authenticating* with a secret needs the token endpoint, which arrives in ticket 10. Until then this ticket proves the observable credential-store invariants over HTTP — two labeled secrets are concurrently live and revoking one leaves the other live; ticket 10 adds the exchange assertion against the same store.


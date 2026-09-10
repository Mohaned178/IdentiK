# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

NestJS + TypeScript (backend) · React + TypeScript (frontend — dashboard, hosted authentication pages, Account Center). Fixed constraint from the project brief, not open for debate. Remaining technology selection (database, OIDC library, SMTP transport implementation, hosting) is explicitly undecided and belongs to implementation tickets.

## Users

- **Instance Operators** — engineers who deploy IdentiK into infrastructure their compliance/security requirements demand they control. Their job: boot, configure the trust fabric (SMTP, keys), and never think about it again.
- **Administrators** (Owners and Members) — platform-side humans like Ahmed, Sara, Layla who run an Organization: register Applications, manage credentials and redirect URIs, view and manage Identities/Enrollments/Sessions, read the audit surface. Never see or set anything that authenticates.
- **End Users** — people like Mohamed who authenticate to client Applications through hosted sign-in pages and manage their security in the Account Center. Non-expert audience: security state must be recognizable, not expert-readable.
- **Client-application developers** — integrate their app (Zotac) via standard OIDC with zero proprietary SDK; any off-the-shelf OIDC library must just work.

## Product Purpose

IdentiK is a self-hostable Identity Provider — "Keycloak without the pain." A team outsources identity and authentication (sign-up, verification, sign-in, recovery, sessions, user management, audit) for their applications instead of building it, while identity data stays in infrastructure they control. Success: the coherence arc — an Instance bootstraps, an Owner registers an Application, an End User signs up/verifies/signs in via standard OIDC, and Administrators manage the full security lifecycle, every step observable over the two seams (HTTP surface, outbound email).

## Positioning

Self-hosted-first with Organization as a first-class tenancy unit — one artifact that could later run hosted multi-tenant without rewrite. The differentiator is the trust boundary itself: where Auth0/Clerk ask customers to hand identity data to a third party and Keycloak exacts operational pain, IdentiK sells control-with-simplicity. Knowingly wrong for customers who don't care where identity data lives.

## Operating Context

- Deployed inside customer infrastructure; the Operator brings their own SMTP and dependencies. Every feature must be boring to operate (single deployment, upgrade without fear).
- Two test seams only: the instance HTTP surface (OIDC endpoints + Management API) and captured outbound email. No test inspects storage, token internals, or module structure.
- Standard OIDC everywhere: discovery, JWKS, code + PKCE. Interop is contractual, not aspirational.
- Dashboard consumes the same Management API as everything else — no dashboard-only back doors.
- Terminology is governed by CONTEXT.md (Identity, Enrollment, Session, Organization, Administrator, End User — with banned vocabulary). Domain decisions live in docs/adr/0001–0023; MVP scope in docs/adr/0023 and .scratch/identity-platform-mvp/spec.md.

## Capabilities and Constraints

Confirmed MVP (password-only first release): Bootstrap Ceremony → default Organization → first Owner; Owner/Member invitation; Application registration (Web confidential / SPA-Mobile public, PKCE); full Client credential lifecycle (show-once concurrent secrets); exact-match redirect URIs; email+password sign-up with verification gate; sign-in/sign-out; forgot/reset with pre-claimed-email healing; Account Center (Sessions, password change, verified email change, connected Applications); Identity/Enrollment views; two-level suspension with immediate revocation; force reset; anonymization-as-deletion; Application disable/delete; full standard OIDC surface; unified audit surface; per-Organization branding, password policy, session timeout; throttling without lockout.

Explicitly deferred: TOTP MFA (first post-MVP increment), social login/External Identities, M2M Applications, consent/third-party Applications, Application environments, hosted mode, application-role storage, impersonation.

Hard product invariants: Administrators never touch credentials; public clients never hold secrets; unverified email = inert reservation; email unique per Organization; revocation immediate at the platform with honest propagation to Applications; no lockout, ever; deletion = anonymization with surviving audit.

## Brand Commitments

Product name: **IdentiK**. Logo, voice, and visual assets: undecided — future work must not invent legal claims, testimonials, or brand imagery beyond the name without new commitment.

## Evidence on Hand

- CONTEXT.md — domain glossary (terminology authority)
- docs/adr/0001–0023 — decision record
- .scratch/identity-platform-mvp/spec.md — MVP spec (66 user stories, seam-based testing contract)
- .scratch/identity-platform-mvp/issues/01–21 — tracer-bullet tickets in dependency order
- No code, no visual assets, no marketing copy exist yet. Nothing may be fabricated as evidence.

## Product Principles

1. **Trust boundaries are the product.** Administrator/End-User population split, Organization tenancy, state-levers-not-credentials — security structure over security theater.
2. **Boring to operate is a feature.** The self-hoster's IdP outage must degrade issuance, not every running application.
3. **Standards are the contract.** Zero-SDK OIDC interop, verified by stock client libraries in tests.
4. **We authenticate and assert; you authorize.** Application business logic never lives in the platform.
5. **Honest semantics, no lying UI.** "Immediate" means immediate where true; propagation is stated, not obscured. The dashboard never promises what the platform cannot deliver.

## Accessibility & Inclusion

WCAG 2.2 AA — binding across all surfaces (hosted sign-in/reset pages, Account Center, dashboard).

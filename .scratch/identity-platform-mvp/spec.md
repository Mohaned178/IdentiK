# Identity Platform — MVP (Password-Only First Release)

Status: ready-for-agent

## Problem Statement

A team whose compliance, security, or data-ownership requirements force identity data into infrastructure they control has three bad options: Keycloak (control, but painful to operate and administer), cloud IdPs like Auth0/Clerk (great UX, wrong trust model — identity data leaves their perimeter), or building authentication inside their application (insecure and expensive). Ahmed owns Zotac and needs sign-up, sign-in, recovery, sessions, and user management — without building any of it, and without handing his users' identity data to a third party.

## Solution

A self-hostable Identity Provider — "Keycloak without the pain." The Instance Operator deploys one instance into their own infrastructure. On first boot, a Bootstrap Ceremony establishes the default Organization and its first Owner. Owners register Applications (Web or SPA/Mobile), configure redirect URIs, and manage client credentials. End Users sign up with email and password, verify their email, and authenticate through the platform's hosted, per-Organization-branded pages using standard OIDC (authorization code + PKCE) — so any off-the-shelf OIDC library integrates a client application with zero proprietary SDK. Administrators manage Identities, Enrollments, Sessions, Applications, and a first-class audit surface from a dashboard that is itself just the first client of a single Management API.

## User Stories

1. As an Instance Operator, I want a Bootstrap Ceremony on first boot, so that the default Organization and first Owner are established securely without manual database surgery.
2. As an Instance Operator, I want the one-time setup flow to expire, so that an abandoned installation cannot be claimed later.
3. As an Owner, I want to invite Administrators by email, so that my team can help manage the Organization without me ever choosing their credentials.
4. As an invited Administrator, I want to set my own password through the invitation link, so that nobody else ever knows my credential.
5. As an Owner, I want to assign Owner and Member roles, so that destructive actions are separated from day-to-day administration.
6. As a Member, I want to perform routine user and Session management, so that operations don't queue behind an Owner.
7. As an Owner, I want destructive actions (secret revocation, redirect URI changes, Application deletion) reserved to Owners, so that a compromised Member account cannot silently redirect authorization codes.
8. As an Administrator, I want a dedicated administrator sign-in separate from End-User authentication, so that compromising an application session never yields tenant administration.
9. As an Owner, I want to register a Web Application, so that my server-rendered app authenticates as a confidential client.
10. As an Administrator, I want to register a SPA/Mobile Application, so that public clients authenticate via PKCE.
11. As an Administrator, I want SPA/Mobile registrations to never be issued a Client Secret, so that a leakable secret structurally cannot exist.
12. As an Administrator, I want the Client ID public and permanent, so that it can appear in URLs and logs and never breaks integrations by rotating.
13. As an Administrator, I want the Client Secret displayed exactly once at generation, so that not even another Administrator can read it back.
14. As an Administrator, I want multiple concurrent labeled secrets, so that I can rotate with zero downtime and identify which credential leaked.
15. As an Administrator, I want to revoke an individual secret immediately, so that a leaked credential is a routine incident rather than an outage.
16. As an Owner, I want redirect URIs matched exactly on scheme, host, port, and path, so that wildcards can never smuggle authorization codes to attacker-controlled paths.
17. As an Owner, I want HTTPS required with a loopback-only HTTP exception, so that local development stays honest without weakening production.
18. As an Owner, I want every redirect URI change recorded as a first-class security event, so that "who added that URI, when" is always answerable.
19. As an End User, I want to sign up with email and password, so that I can start using an application.
20. As an End User, I want my Identity inert until I verify my email, so that nobody can act as me before proving mailbox control.
21. As an End User, I want the verification link to activate my Identity, so that I can authenticate immediately after clicking.
22. As an End User, I want a forgotten-password reset link, so that I can recover control through my own mailbox.
23. As an End User, I want a reset link to count as mailbox proof, so that an email pre-claimed by an attacker heals to me without Administrator intervention.
24. As an End User, I want to sign in on the platform's hosted pages, so that client applications never see my password.
25. As an End User, I want my existing platform Session recognized when signing in to a new application, so that enrollment in CodeBoard after Zotac is one click, not a second credential.
26. As an End User, I want sign-in pages themed per-Organization, so that I always recognize whose login I am at.
27. As an End User, I want sign-out to revoke my current Session, so that logout means what it says.
28. As an End User, I want a password change to revoke my other Sessions, so that a stolen-laptop Session dies when I harden my account.
29. As an End User, I want an Account Center showing my active Sessions with recognizable device metadata, so that I can spot an unfamiliar sign-in.
30. As an End User, I want to revoke a single Session, so that I can evict a lost phone without signing out everywhere.
31. As an End User, I want to change my email with verification of the new address, so that my handle is never unverified.
32. As an End User, I want to see which Applications I am enrolled in, so that I know where my Identity is used.
33. As an End User, I want to use one password across all my Organization's Applications, so that I hold one credential per Organization, not per app.
34. As an Administrator, I want to view Identities with their authentication state, so that I can support and audit my Organization's people.
35. As an Administrator, I want to view Enrollments per Application, so that I can see "Zotac's users" as a real list.
36. As an Administrator, I want to suspend an Enrollment, so that a user loses one Application without losing others.
37. As an Administrator, I want to suspend an Identity, so that a bad actor loses all access in the Organization immediately.
38. As an Administrator, I want suspension to take effect immediately at the platform, so that revocation is a security action, not bookkeeping.
39. As an Administrator, I want to force a password reset that is sent to the verified email, so that I can respond to compromise without ever touching credentials myself.
40. As an Administrator, I want to revoke all of an Identity's Sessions in one action, so that device eviction is routine.
41. As an Administrator, I want to anonymize an Identity irreversibly, so that PII is destroyed while audit history survives pseudonymously.
42. As an Administrator, I want an anonymized email immediately reusable by a fresh unlinked Identity, so that deletion does not permanently burn handles.
43. As an Administrator, I want to be structurally unable to read or set any End User's password, so that administrators cannot become takeover oracles.
44. As an Administrator, I want to disable an Application, so that I can pause an integration reversibly.
45. As an Administrator, I want Application disable to block new authentication and revoke that app's minted refresh tokens immediately, so that pause means pause.
46. As an Owner, I want to delete an Application, so that abandoned integrations can be cleaned up.
47. As an Owner, I want Application deletion to remove Enrollments but never destroy Identities, so that people belong to the Organization, not to Applications.
48. As an Administrator integrating Zotac, I want standard authorization code flow with PKCE, so that any OIDC library integrates without a proprietary SDK.
49. As an Administrator integrating Zotac, I want an OIDC discovery endpoint, so that endpoints and capabilities self-describe.
50. As an Administrator integrating Zotac, I want a published JWKS endpoint, so that tokens verify offline and an IdP outage degrades issuance, not every request path.
51. As an Administrator integrating Zotac, I want ID tokens asserting who, when, email, and verification state, so that Zotac trusts identity without custom parsing.
52. As an Administrator integrating Zotac, I want a userinfo endpoint, so that profile claims are fetchable on demand.
53. As an Administrator integrating Zotac, I want token revocation and introspection endpoints, so that revocation-conscious applications can ask the platform directly.
54. As an Administrator integrating Zotac, I want access token audiences limited to platform endpoints, so that the boundary "we authenticate, you authorize" is enforced by the tokens themselves.
55. As an Administrator integrating Zotac, I want standard scopes (openid, email, profile) as integration configuration, so that token contents are deliberate, not accidental.
56. As an End User, I want Sessions to represent devices and survive browser closes, so that my Session list is recognizable, not a list of cookies.
57. As an Administrator integrating Zotac, I want short access-token TTLs with rotating refresh tokens parented by Sessions, so that stolen tokens die fast and revocation is honest.
58. As an Administrator, I want failed authentication attempts recorded with source and target, so that credential campaigns against my Organization are visible.
59. As an Administrator, I want every security-relevant event (auth failures, suspensions, credential changes, redirect changes, invitations, deletions) in one audit surface, so that "who did what, when" is always answerable.
60. As an End User, I want sign-up and sign-in responses uniform in shape and timing regardless of email existence, so that attackers cannot enumerate Identities at the HTTP layer.
61. As an End User, I want escalating throttling instead of hard lockout, so that nobody can lock me out of my account by spamming wrong passwords.
62. As an Administrator, I want the dashboard to consume the same Management API as everything else, so that the platform grows no dashboard-only back doors.
63. As an Administrator, I want Management API access restricted to Administrator sessions in this release, so that client backends cannot silently gain administrative power before the machine-to-machine Application type exists.
64. As an Owner, I want per-Organization password policy and session timeout, so that policy follows my Organization, not the instance.
65. As an Instance Operator, I want the trust fabric (SMTP transport, signing keys, trusted external providers) held in deployment configuration, so that configuration which could compromise every Organization is never changeable from a dashboard.
66. As an End User, I want verification, reset, and invitation mail delivered through the Operator's configured SMTP transport, so that mailbox proofs reach me reliably.

## Implementation Decisions

- **Artifact shape**: One codebase, two operational modes — self-hosted single-tenant is the primary release; the Organization-scoped data model keeps a future hosted multi-tenant mode compatible without rewrite. Every domain concept carries its Organization scope from day one.
- **Stack (fixed constraint)**: NestJS + TypeScript. Database, protocol library, and email transport implementation are the first implementation decisions; they must not leak above the tested seams.
- **Two populations**: Administrators and End Users are distinct entity types with separate credential stores, separate sign-in flows, and separate session types. No shared login path, ever.
- **Tenancy**: Organization is mandatory and first-class. An Application belongs to exactly one Organization forever. An Identity belongs to exactly one Organization. Membership is the scoped record Administrator + Organization + role (Owner or Member).
- **Bootstrap**: First boot creates the default Organization and an expiring one-time setup flow that establishes the first Owner. No self-serve path to administration; invitation by email is the only entry point for additional Administrators, and invitees set their own passwords.
- **Identity model**: One Identity per person per Organization; Applications see Enrollments. Enrollment is created silently at an Identity's first authentication through an Application (no consent screens — all Applications are first-party). Credentials attach to the Identity, never to an Application.
- **Email semantics**: Email uniquely identifies an Identity within its Organization. An unverified Identity is an inert reservation — it cannot authenticate, enroll, or appear as usable. Any proof of mailbox control (verification link or password-reset link) marks the email verified. Every authenticated Identity has a verified email; a working SMTP path is therefore a hard prerequisite for any login.
- **Application types**: Web (confidential client; backend holds a Client Secret) and SPA/Mobile (public client; PKCE replaces the secret; a Client Secret is never issued to a public client under any circumstance). Authorization code + PKCE is the sole MVP flow.
- **Client credentials**: Client ID is public and permanent. Client Secrets are stored in verifiable form only, displayed exactly once at generation, support multiple concurrent labeled secrets with individual revocation (zero-downtime rotation), and carry creation timestamps.
- **Redirect URIs**: Exact match on scheme, host, port, and path — no wildcards or prefixes. HTTPS required, plain HTTP only for loopback. Changes are Owner-governed, Organization-scoped, audit-logged as first-class security events.
- **Session model**: A Session is the durable record of one authentication of one Identity — it *is* the signed-in device, carries recognizable device metadata, and survives browser closes. It parents the platform SSO cookie and every refresh token minted through any Application's flow. Revoking a Session invalidates the cookie and all descendant refresh tokens immediately. Access tokens are deliberately untracked, signed JWTs with short (minutes) TTLs, verifiable offline via JWKS. Refresh tokens rotate. Password change preserves the current Session and revokes all others. Logout is revocation of the current Session.
- **Suspension**: Two levels — Enrollment suspension (blocks one Application) and Identity suspension (blocks the Organization-wide Identity). Both take effect immediately at the platform; client applications lose the user as their tokens validate (honest propagation). Suspension is the only "this actor is done" decision; there is no hard lockout.
- **Deletion**: Deletion means anonymization, for both Identities and Applications. Identity: PII destroyed, sessions and enrollments revoked, audit survives against a pseudonymous shell, email immediately reusable by a fresh unlinked Identity, irreversible. Application: Enrollments removed, credentials revoked immediately, audit pseudonymized; orphaned Identities survive. An intermediate Disabled state exists for Applications (blocks new authentication, revokes app-minted refresh tokens, preserves Sessions).
- **Administrator rights**: State levers only — suspend/unsuspend, revoke Sessions, force password reset (delivered to the existing verified email), anonymize, disable/delete Applications, manage credentials and redirect URIs (Owner-only for destructive ones). Administrators never read or set anything that authenticates. Impersonation does not exist.
- **OIDC surface**: Standard endpoints — authorization, token, userinfo, revocation, introspection, discovery, JWKS. ID tokens carry the identity assertion. Access token audience is platform endpoints only, never client application resources. Scopes (openid, email, profile) are integration configuration governing token contents, not user-granted permissions.
- **Authorization boundary**: The platform is an authentication platform, not an authorization engine. No application-role storage, no permission engine, no policy language. Platform-internal authorization is Owner/Member only.
- **Anti-abuse**: Uniform response shape and timing for email-existence-adjacent flows (nothing confirmed at the HTTP layer). Rate limiting with escalating delay, per-source and per-Identity. No hard lockout ever. Failed authentication attempts are audit events carrying source and targeted Identity.
- **Management API**: A single Management API is the only programmatic surface; the dashboard is its first client. Only Administrator sessions may call it in this release.
- **Settings boundary**: Instance-scoped trust fabric (SMTP transport, signing keys, trusted external providers) lives in deployment configuration. Organization-scoped policy (branding, password policy, session timeout) is dashboard-governed and audit-logged.
- **Audit surface**: First-class and unified — authentication failures, suspensions, credential issuance/revocation, redirect URI changes, invitations, anonymizations, application disable/delete.

## Testing Decisions

- **What makes a good test**: Tests drive black-box conversations through the two confirmed seams and assert externally observable behavior only — HTTP status, redirect targets, token verifiability via JWKS, email contents, timing/shape uniformity. No test inspects databases, token internals, or module structure; those are implementation details the seams exist to protect.
- **Seam 1 — the instance HTTP surface**: OIDC protocol endpoints plus the Management API. A standard off-the-shelf OIDC client library acts as the test actor for client-application flows, which makes "any library integrates with zero SDK" an executable assertion rather than a claim. The full coherence loop is one test arc: Bootstrap Ceremony → invite Member → register Web Application → End-User sign-up → verify via captured email → authorize (silent enrollment) → exchange code → verify JWT against JWKS → suspend Identity → observe revocation.
- **Seam 2 — outbound email transport**: The SMTP transport boundary is abstracted with an in-memory capture implementation; tests assert on delivered mail (verification links, reset links, invitations) as the driver of mailbox-proof flows.
- **Named scenario tests the decisions demand**: pre-claimed-email healing (refused sign-up → forgot-password → reset click proves ownership); password-change session cascade (other Sessions die, current survives); concurrent-secret rotation (both secrets valid, revoking one does not affect the other); immediate suspension propagation (session invalid for anything that asks, access tokens expire within one short TTL); exact-match redirect rejection (scheme, port, path, and prefix mismatches all refused); uniform sign-up timing (identical response shape and latency whether the email exists or not); public client never issued a secret; anonymization (email reusable, audit pseudonymous, irreversible); application deletion (Enrollments removed, Identities survive).
- **Prior art**: None — greenfield. This spec establishes the repository's testing pattern: full-stack black-box tests against a live instance.

## Out of Scope

- TOTP MFA and recovery codes (first post-MVP increment; MFA is modeled as attachable authentication factors so it arrives additively).
- Social login / External Identity federation (model fully settled; ships as second increment, along with the different-email and merge flows).
- Machine-to-machine Application type and programmatic Management API access for client backends.
- Consent screens and third-party Applications (Enrollment records are shaped so consent can attach later without migration).
- Application environments as a first-class structure.
- Hosted multi-tenant operation mode.
- Application role/permission storage, impersonation, SMS/email-OTP factors, hard lockout, front/back-channel logout propagation.
- Technology selection beyond the fixed stack (NestJS/TypeScript, React/TypeScript): database, OIDC protocol library, token signing library, email transport implementation, hosting.

## Further Notes

- This spec synthesizes a completed domain-modeling session recorded as a glossary (`CONTEXT.md`) and 23 ADRs (`docs/adr/0001`–`0023`) covering positioning, tenancy, identity model, lifecycle, credentials, sessions/tokens, security posture, and MVP scope. Those documents are the terminology authority; where wording differs, they win. Banned vocabulary (unqualified "User", "Account", "Customer", "Developer", "Tenant", unqualified "Role", "Application User") must not appear in code or docs.
- Open parameter decisions deliberately left to implementation, constrained by the tests: exact access-token TTL and rotation cadence, rate-limit thresholds, password-policy defaults, signing-key rotation cadence, audit retention, invitation/setup expiry windows, per-Organization branding depth.
- The coherence demo this release must satisfy end-to-end: Ahmed's Instance bootstraps → default Organization → Zotac registered as a Web Application → Mohamed signs up, verifies, signs in to Zotac via standard OIDC → Ahmed suspends him and revokes his Sessions → anonymizes him — every step observable at the two seams.

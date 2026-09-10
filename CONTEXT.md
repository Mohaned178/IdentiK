# Identity Platform

A self-hostable Identity Provider — "Keycloak without the pain" — that lets a team outsource identity and authentication for their applications into infrastructure they control. This file is the glossary: the single authority on what our domain terms mean. Where wording elsewhere differs, this file wins.

## Language

### Platform side

**Instance**:
One deployment of the platform, run by an Instance Operator.
_Avoid_: Server, Environment (as deployment)

**Instance Operator**:
The party running a deployment — the customer in self-hosted mode, us in a future hosted mode. Holds the trust fabric.
_Avoid_: Host, Admin (as operator)

**Organization**:
The customer entity and the trust/tenancy boundary. Owns Applications and Identities. Exactly one per Instance today; many in a future hosted mode.
_Avoid_: Customer, Tenant, Company, Workspace

**Administrator**:
A platform-side human who administers an Organization through the dashboard. A separate population from End Users, with separate credentials and sign-in.
_Avoid_: Developer, Customer, User

**Administrator Role**:
Either **Owner** (everything, including destructive settings) or **Member** (day-to-day administration).

**Membership**:
The scoped record binding an Administrator to an Organization with an Administrator Role. One human may hold different roles in different Organizations.

**Bootstrap Ceremony**:
The one-time, expiring first-boot flow that establishes the default Organization and its first Owner. The only way the first Administrator comes to exist.

**Management API**:
The single programmatic surface of the platform. In this release, callable only by Administrator sessions; the dashboard is its first client.

### End-user side

**End User**:
The human behind an Identity, authenticating to client applications. Never an Administrator.
_Avoid_: User

**Identity**:
One person scoped to one Organization: owns the email, credentials, and Sessions. Never owned by an Application.
_Avoid_: Account, User, Application User, per-app user

**Enrollment**:
An Identity's membership in one Application, created silently at first authentication. The unit application user-lists are made of.
_Avoid_: Application User, Account, Membership

**Credential**:
An authentication method attached to an Identity — a password or an External Identity. (Future MFA factors follow the same attachable pattern.) An Identity never drops to zero credentials.
_Avoid_: Login, Key

**External Identity**:
A (provider, subject ID) pair from an external provider, attached to an Identity as a federated credential. Trusted-provider attestation counts as mailbox proof.
_Avoid_: Social account, Linked account, Provider user

**Session**:
The durable record of one authentication of one Identity — the signed-in device, surviving browser closes. Parents the SSO cookie and every refresh token minted from it. The revocable anchor of the whole system.
_Avoid_: Login, Browser state, Token

**Account Center**:
The platform-hosted self-service surface for End Users: Sessions, password change, verified email change, connected Applications.
_Avoid_: Profile page, Settings (as a general term)

**Unverified Reservation**:
An inert Identity state: email claimed, mailbox not yet proven. Cannot authenticate, enroll, or consent. Heals to the mailbox's true owner via any proof-of-mailbox flow.
_Avoid_: Pending user, Inactive account

**Anonymization**:
What deletion means here: PII destroyed irreversibly, Sessions and Enrollments revoked, audit history preserved against a pseudonymous shell, email immediately reusable by a fresh unlinked Identity.
_Avoid_: Hard delete, Soft delete, Tombstone

### Application side

**Application**:
A registered client integration owned by exactly one Organization, forever. Web (confidential) or SPA/Mobile (public). Cheap and disposable because it owns no Identities — only Enrollments.
_Avoid_: Client (that is the OAuth role, not the entity), Service, Project

**Client ID**:
An Application's public, permanent identifier. Appears in URLs and logs; never secret, never rotated.

**Client Secret**:
A confidential Application's credential: stored verifiable-only, shown exactly once at generation, multiple concurrent labeled secrets, individually revocable.
_Avoid_: API key, Token

**Web Application**:
Confidential client type: a backend that can hold a Client Secret. Authorization code flow.

**SPA/Mobile Application**:
Public client type: cannot hold anything secret; PKCE does that job. Never issued a Client Secret under any circumstance.

**Disabled Application**:
Intermediate state: new authentication blocked, app-minted refresh tokens revoked immediately, Sessions survive. Reversible.

**Scope**:
Integration configuration governing token contents (openid, email, profile). Not a user-granted permission in this release.
_Avoid_: Permission, Grant

### Authorization boundary

*We authenticate and assert; you authorize.* The platform's assertions stop at who the person is. Application roles and permissions are the client application's domain data — never stored, decided, or enforced here. Unqualified "Role" is banned vocabulary: it is either an Administrator Role (ours) or an application role (theirs).

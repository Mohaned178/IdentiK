# 12: Dashboard — Identity and Enrollment views

**What to build:** The Administrator's window into the Organization's people (spec stories 34–35). The Identity list shows every Identity with authentication state; the Identity detail page shows email, verification state, Enrollments, active Sessions, and recent authentication activity — everything security-relevant per ADR-0008, and nothing that authenticates. The per-Application view is formally Enrollments filtered to that Application: "Zotac's users" is a real list. Management levers arrive in ticket 13; this ticket is visibility, consumed via the Management API.

**Blocked by:** 08 (audit surface exists; recent activity reads from it), 09 (Enrollments and Sessions exist as viewable records).

**Status:** done

- [x] The Identity list shows all Identities of the Organization with their authentication state
- [x] The Identity detail page shows email, verification state, Enrollments, active Sessions, and recent authentication activity
- [x] No screen exposes or permits setting anything that authenticates — passwords are invisible and unsettable
- [x] The per-Application view lists Enrollments filtered to that Application
- [x] Unverified reservations are visible and clearly flagged as inert
- [x] Anonymized Identities (once ticket 15 lands) will display pseudonymously — the view degrades gracefully for them
- [x] Views consume the Management API (no dashboard-only back door)
- [x] Black-box tests assert view contents over HTTP only

## Comments

Implementation notes:

- Endpoints (all Management API, `AdministratorGuard`): `GET /api/identities` (directory list), `GET /api/identities/:id` (detail), and `GET /api/applications/:id/enrollments` (per-Application view). Every read is scoped to the caller's Administrator session Organization; Members can view (visibility is day-to-day administration), anonymous callers get 401, and there is no PATCH/POST route on the identity surface. The controller lives in `identities/identities.controller.ts`; the view composition in `identity-directory.service.ts`.
- Identity view: `{ id, email, emailVerified, state, createdAt }` where `state` is the derived authentication state — `suspended` > `unverified` > `active` (`identity-state.ts`, shared with the Enrollment views). An unverified reservation is therefore `emailVerified: false, state: "unverified"` and clearly inert. The suspended branch is implemented now; ticket 13 supplies the action that sets the column.
- Detail: Enrollments (application name/type, enrolledAt, enrollment suspension), active Sessions from `SessionsService.listForIdentity` (the same fail-closed liveness gate the Account Center uses, so suspended/unverified identities show no live devices), and `recentActivity` — the unified audit surface filtered by Identity, newest first, capped at 20. The filter is the new `AuditFilters.identityId`, resolved with `json_extract(detail, '$.identityId')` and deliberately not exposed as an audit HTTP query parameter: the detail endpoint is the consumer. Linkage is by `identityId`, never email — the durable key once anonymization destroys the address and reuse recycles it (ADR-0007). Consequence, accepted: `identity.reservation.created` (which carries email only) does not appear in an Identity's activity.
- No credentials: the views project identity and state columns only — no `password_hash`, no identity tokens, no credential route. The black-box test asserts neither list nor detail serialization contains password/token-hash material, and that `POST /api/identities/:id/password` and `PATCH /api/identities/:id` are 404.
- Per-Application view: `EnrollmentsService.listForApplication` joins identities for Organization scoping and returns `{ identityId, email, emailVerified, state, enrolledAt, suspended }` — identity state and Enrollment suspension are independent levels (ADR-0006). The service itself asserts the Application exists in the Organization first, so unknown or foreign Applications are 404, never an empty list, from any caller.
- Anonymized degradation (ticket 15): the view reads the identity row as-is and derives state without assuming the email survives, so nothing in this ticket fabricates or leaks a pseudonymous shape. Ticket 15 will widen the contract deliberately — `state` gains an `anonymized` value and the email becomes pseudonymous — rather than the view guessing now. No test can cover that branch until ticket 15 exists.
- Successful authorizations are not audit events in this release: ADR-0023 enumerates the audit surface as failures, suspensions, credential events, redirect changes, invitations, and deletions. `recentActivity` therefore shows what the surface actually records (verification, sign-in failures, enrollments, session revocations); a "who signed in from that IP last Tuesday" success trail would be an audit-surface extension, not a view concern.
- Wiring: `IdentitiesModule` imports `AdministratorsModule` (guard + now-exported `AuditService`) and `SessionsModule`; `ApplicationsModule` imports `EnrollmentsModule`. No new tables or migrations.
- Tests: `e2e/src/identity-directory.test.ts` (7 tests) drives the real sign-up/verify/authorize arc with a Member and an Owner, then asserts list contents and state, detail Enrollments/Sessions/activity (including ordering and cross-Identity isolation), the inert reservation, Application-filtered Enrollments with a 404 for unknown Applications, Administrator-only access, and the absence of credential exposure or setting routes. 152 tests pass in the full suite.
- Review round applied: removed a banned-vocabulary quote, hoisted the shared `requireAdministratorSession` from three controller copies, moved the Application-existence 404 into `listForApplication` so the service's contract is self-contained, and inlined a pass-through state helper.
- Deferred: the suspension/revocation levers and their cascade (ticket 13); anonymized presentation and the anonymization action (ticket 15); per-Application activity filtering beyond the Identity detail; auditing successful authentications if the audit surface later decides to carry them.

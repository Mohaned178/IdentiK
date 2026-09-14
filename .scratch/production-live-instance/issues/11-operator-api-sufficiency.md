# 11: Prove the Management API can operate the live Instance

Type: task

Status: resolved

## Question

Can every go-live operator task — the bootstrap ceremony, Administrator invitation, Application registration, and instance/organization settings — be completed through the *existing* Management API via a documented curl runbook, with no dashboard?

Work alone (AFK): walk each task against the current routes and record what exists, what is awkward but workable, and what is genuinely missing. Assume sufficiency until proven otherwise. If gaps block go-live, name them precisely with the missing calls. Do not silently import the backend-completion map's open Management-API questions — anything beyond go-live operator tasks belongs to that map, flagged, not absorbed. Resolve with the findings and either the curl-runbook outline or the blocking gap list.

## Answer

**Verdict: the existing Management API is sufficient to operate the live Instance with no dashboard. No go-live blockers.** Every go-live operator task has a route (evidence below, all verified against `backend/src` controllers and services). Three genuine gaps exist but none blocks the dogfooding phase; they are flagged for the backend-completion map's Management-API question, not absorbed here.

### Covered (verified)

- **Bootstrap:** `GET /api/setup/status` → `{completed, available}`; setup token printed once to stdout at first boot (`bootstrap.service.ts`, read via `docker compose logs`); `POST /api/setup?token=…` with `{organizationName, email, password, name}` → 201 creates the Organization and first Owner.
- **Administrator session:** `POST /api/administrators/sign-in` (cookie `identik_admin_session`), `POST /api/administrators/sign-out`, `GET /api/administrators/session`.
- **Invitations:** `POST /api/administrators/invitations` (Owner-only, `{email, role?}`) with delivery over the live SMTP relay; `GET /api/administrators/invitations?token=…` (public inspect); `POST /api/administrators/invitations/accept` (public, invitee sets own password).
- **Applications:** `POST /api/applications` (web type is Owner-only since it mints a secret; returns `{application, clientSecret}` shown once), `GET` list, `GET :id`, disable/enable, `DELETE :id`.
- **Client secrets:** `POST :id/secrets` and `POST :id/secrets/:secretId/revoke`, both Owner-only.
- **Redirect URIs:** `POST/PATCH/DELETE :id/redirect-uris…`, Owner-only; plus `PUT :id/scopes`.
- **Settings:** `GET /api/organization` (id, name); `GET/PUT /api/organization/settings` (read any Administrator, write Owner-only; branding, password policy, session policy). Trust fabric correctly absent per ADR-0022.
- **Identity operations:** `GET /api/identities` (directory list), `GET :id`, suspend/unsuspend, `POST :id/sessions/revoke-all`, `POST :id/force-password-reset`, `POST :id/anonymize`; per-application `GET :id/enrollments` with enrollment suspend/unsuspend.
- **Visibility:** `GET /api/audit` (actor/kind/from/to filters); `/health/live`, `/health/ready`, `/health`.
- **End-user flows** (for the acceptance round-trip): `/api/end-users/*` (sign-up, verify, password), `/oidc/*` (authorize, token, userinfo, discovery) — all API-driven, so the mailbox proof round-trip is curl-executable against a real mailbox.

### Gaps (real, non-blocking, flagged outward)

1. **No Administrator password change/rotation** — password is set at bootstrap/accept and never changeable via API. Acceptable for one operator with a strong initial secret; must be addressed before multiple Administrators. → backend-completion map, Management-API completeness.
2. **No invitation listing/revocation** — a misaddressed invite can only expire (default 7-day TTL). Awkward but workable; already ruled optional-polish in the floor spec.
3. **No Administrator listing, role change, removal, or foreign-session revocation** — irrelevant for a single Owner; belongs to the backend-completion map.

### Runbook wrinkles for the follow-on effort (not gaps)

- The setup token is shown once and cannot be re-revealed; a restart before completion forces reinstall (documented code behavior) — the runbook must capture the token from first-boot logs.
- The first-boot log points at a `/setup` page that does not exist (no frontend); the actual call is `POST /api/setup?token=…` — the curl runbook documents this.
- Administrator auth is cookie-based; the curl runbook needs a cookie jar (`-c/-b`).

### Curl-runbook outline (for the execution effort)

`docker compose logs` → token → `GET /api/setup/status` → `POST /api/setup?token=` → sign-in (cookie jar) → invite/accept or operate directly → applications, secrets, redirect URIs, settings, identities, audit as above.

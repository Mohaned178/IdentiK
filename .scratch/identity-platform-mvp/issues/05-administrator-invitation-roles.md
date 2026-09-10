# 05: Administrator membership — invitation + Owner/Member roles

**What to build:** The platform's own membership lifecycle (ADR-0021), obeying the rules it sells. An Owner invites an Administrator by email; the invitee receives a link and sets their own password — the inviter never chooses a credential (ADR-0008 applied to our own population). Invitation links expire. Invited Administrators sign in via the dedicated Administrator sign-in and receive a Membership scoped to the Organization with a role: Owner or Member. Invitation is Owner-only, and destructive settings are reserved to Owners (ADR-0016); this ticket enforces the role distinction at the Management API for the actions that exist so far (invitation itself). There is no self-serve path to administration. Everything is audit-logged.

**Blocked by:** 02 (Administrator population, dedicated sign-in, and audit store exist).

**Status:** done

- [x] An Owner can invite an Administrator by email; the invitation email is delivered via the outbound mail boundary (captured in tests)
- [x] The invitee sets their own password through the invitation link; the inviter never sees or sets it
- [x] Invitation links expire and are single-use
- [x] The invited Administrator signs in via the dedicated Administrator sign-in and receives a Membership scoped to the Organization with their role
- [x] Invitation creation is Owner-only: a Member attempting to invite is refused by the Management API
- [x] The Owner/Member role distinction exists on the Membership record and is enforced at the Management API for the actions in scope of this ticket
- [x] No self-serve path to administration exists anywhere on the HTTP surface
- [x] Invitation issuance, acceptance, and expiry are audit events
- [x] Black-box tests cover the full invitation arc and the role-based refusal over HTTP only

## Comments

Implementation notes:

- Management API surface: `POST /api/administrators/invitations` (Owner-only, `{ email, role }` — never a credential), `GET /api/administrators/invitations?token=` (page data; email/role are `null` unless the link is live), `POST /api/administrators/invitations/accept` (`{ token, name, password }`). Membership role lands on `memberships.role`, already modelled in ticket 02.
- Owner-only enforcement is a second guard, `OwnerGuard`, composed after `AdministratorGuard`; a valid Member session is 403. ADR-0016 reserves destructive/privilege-granting actions to Owners.
- Invitation state lives in `administrator_invitations` (migration v4): single-use and expiring via the race-free `UPDATE ... WHERE consumed_at IS NULL AND expires_at > ?` pattern shared with the End-User mailbox-proof tokens. The token is stored verifiable-only.
- Expiry has no scheduler, so it is recorded the first time a dead link becomes observable — the hosted page's `inspect` (GET) and a direct accept both call a guarded `expiry_audited_at` update, so the event fires exactly once across either path. Issuance and acceptance audit the acting Administrator as actor. Issuance and acceptance events carry the invitation and role in their detail.
- "No self-serve path" is structural: the only ways to create an Administrator are the Bootstrap Ceremony and a valid single-use invitation. The suite asserts `POST /api/administrators/sign-up` and `POST /api/administrators` are 404 and an unauthenticated invite is 401.
- `LinkBaseService` moved from `identities` to a shared global `ConfigModule` (`src/config/`); the audit writer, SQLite uniqueness check, and TTL env parsing are shared helpers (`storage/audit.ts`, `storage/sqlite.ts`, `config/env.ts`) rather than copies.
- Parameter choice left open by the spec: `IDENTIK_INVITATION_TOKEN_TTL_MS`, default 7 days.


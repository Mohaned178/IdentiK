# 08: Unified audit surface in the dashboard

**What to build:** The dashboard's viewer for the audit store born in ticket 02. One surface, first-class: every security-relevant event recorded so far — bootstrap, invitations, credential issuance and revocation, redirect URI changes — is visible with who/what/when, filterable enough to answer "who added that URI, when?" in seconds. Later tickets (suspension, anonymization, application lifecycle, throttling failures) record into this surface as acceptance criteria; this ticket makes the accumulated record observable to Administrators. The viewer consumes the Management API like every other dashboard screen.

**Blocked by:** 05, 06, 07 (enough event kinds exist for the surface to be real rather than a bootstrap-only stub).

**Status:** done

- [x] All audit events recorded by tickets 02–07 are visible in one dashboard surface with who/what/when
- [x] Events are filterable by actor, event kind, and time range
- [x] Credential and redirect-URI events are present with the same prominence as suspensions will be (one unified surface, no category buried)
- [x] Members can view the audit surface; visibility is not Owner-only
- [x] The viewer consumes the Management API (no dashboard-only back door)
- [x] Black-box tests assert event presence and metadata over HTTP only

## Comments

Implementation notes:

- Management API surface (ADR-0019): `GET /api/audit?actor=&kind=&from=&to=`. Filters are optional, combine with AND, and blank values are treated as absent. `actor` accepts an Administrator id or the email the surface displays, plus the raw pseudo-actors `instance` and `end-user`; `kind` is exact; `from`/`to` are inclusive bounds. Events are returned newest-first (occurred_at, then insertion order for same-millisecond ties).
- Actor resolution: each event keeps its raw `actor` and gains nullable `actorName`/`actorEmail`. The resolution joins `memberships` on `(organization_id, actor)` and then `administrators`, so an Administrator is only ever named through a Membership in the requesting Organization (ADR-0003) — never through the global record. The UI workspace was removed at 815bf37, so the dashboard's viewer is exactly this Management API surface; no dashboard-only path exists.
- Time semantics: `from`/`to` accept an ISO date (UTC midnight) or an ISO date-time carrying an explicit offset (`Z` or ±hh:mm). Slash-separated and offsetless date-times are refused with 400, because `new Date()` would interpret them in the server's local zone and the same filter would select different windows per deployment. A `from` after `to` is refused rather than silently returning nothing.
- Reads stay under `AdministratorGuard` only — Members can view, as required; visibility is not a destructive act. Nothing here is Owner-only.
- Tests: `e2e/src/audit-surface.test.ts` (9 tests) drives the full ticket 02–07 event arc (bootstrap, invitation issue/accept, application registration, secret generate/revoke, redirect URI add/update/remove, sign-up/verify/reset) and asserts every family is present in one response, with who/what/when on every event, actor resolution, each filter and their combination, inclusive bounds, 400s for malformed/ambiguous/inverted times and repeated params, and Member-versus-anonymous access. HTTP only; no DB inspection.
- Deferred: result pagination/caps. Audit retention is an explicit open parameter in the spec, and ticket 08's criteria ask for visibility and filtering, not windowing; a cursor contract can arrive additively when the volume warrants it.

## Comments

Review round applied: migration v15 adds `audit_events(organization_id, occurred_at)` so the newest-first per-Organization read stays bounded as history grows. `AuditService.list` gained an internal `limit` used only by derived views — an Identity's recent activity now caps in SQL instead of reading and `JSON.parse`-ing the whole identity trail and slicing client-side. The Management API's audit read remains complete (no HTTP limit).

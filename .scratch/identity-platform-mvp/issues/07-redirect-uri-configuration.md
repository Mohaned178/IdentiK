# 07: Redirect URI configuration + exact-match validation

**What to build:** Redirect URI management for an Application (ADR-0010). Owners add, edit, and remove redirect URIs in the dashboard via the Management API. Validation is exact match on scheme + host + port + path — no wildcards, no prefixes, ever. HTTPS is required, with a single carve-out: plain HTTP is permitted only for loopback (localhost / 127.0.0.1) so local development stays honest. Every change — add, edit, remove — is recorded as a first-class security audit event in the same surface as suspensions and credential rotations: a silent redirect-URI addition is a code-interception primitive, and "who added that URI, when" must always be answerable. The enforcement itself (comparing a live authorize request against the list) is exercised by ticket 09; this ticket delivers configuration and validation of the stored URIs.

**Blocked by:** 06 (Applications exist to configure).

**Status:** done

- [x] An Owner can add, edit, and remove redirect URIs on an Application via the dashboard, through the Management API
- [x] An invalid URI is rejected at submission: non-HTTPS scheme (except loopback), wildcard or prefix patterns, malformed components
- [x] Plain HTTP is accepted only for loopback hosts; every other plain-HTTP submission is refused
- [x] Exact-match semantics are the only matching mode; no prefix or pattern form is accepted by the configuration API
- [x] Every change is an audit event recording who changed what, when — first-class, in the same surface as suspensions and credential events
- [x] Black-box tests cover acceptance and rejection cases over HTTP only, including the loopback carve-out and audit assertions

## Comments

Implementation notes:

- Management API surface (ADR-0019): `POST /api/applications/:id/redirect-uris` (`{ uri }`), `PATCH /api/applications/:id/redirect-uris/:uriId` (`{ uri }`), `DELETE /api/applications/:id/redirect-uris/:uriId`. All three are Owner-only (`OwnerGuard`) because redirect-URI changes are destructive governance (ADR-0010); reads remain Administrator-level and `ApplicationView` now carries `redirectUris` (id, uri, createdAt, updatedAt) on both list and detail.
- Data model (migration v6): `redirect_uris` (org-scoped through `applications`, `created_by`/`created_at`, `updated_by`/`updated_at`, `UNIQUE (application_id, uri)`). The unique constraint makes each exact-match target single-identity per Application; a duplicate add or edit is a 409.
- Validation (`applications/redirect-uri.ts`): the input is trimmed, rejected if empty or containing `*`, parsed as an absolute URL, then refused for embedded credentials, any `#` (including the empty fragment `...#` that `URL.hash` reports as `''`), and any scheme other than HTTPS — with `http:` admitted only for loopback (`localhost`, 127.0.0.0/8, `[::1]`). The stored value is the canonical `URL.href` (scheme/host lower-cased, default port dropped, empty query delimiter removed), so equivalent spellings collide as duplicates instead of becoming separate match targets.
- Match contract for ticket 09: the exact-match target is the whole canonical URI — scheme + host + port + path, and any query string when present. Equality on more components than the ADR names is strictly safe: it can never admit a URI the four-component comparison would refuse.
- Audit events (ADR-0023): `redirect_uri.added` (applicationId, uriId, uri), `redirect_uri.updated` (plus `previousUri`), `redirect_uri.removed` (applicationId, uriId, uri). Each mutation and its event are written in one transaction, so a persisted URI can never lack its "who changed what, when" event.
- Tests: `e2e/src/redirect-uri-configuration.test.ts` (13 tests) covers acceptance and exact round-trip, wildcard/pattern refusal, malformed components, non-HTTPS schemes, the loopback carve-out, duplicate collisions across canonical spellings, edit/remove lifecycle, Owner-only enforcement, 404 for unknown Applications/URIs, and audit assertions against the same `/api/audit` surface as credential events.
- Deferred: comparing a live authorize request against the stored list is enforcement, delivered by ticket 09.

# 07: Redirect URI configuration + exact-match validation

**What to build:** Redirect URI management for an Application (ADR-0010). Owners add, edit, and remove redirect URIs in the dashboard via the Management API. Validation is exact match on scheme + host + port + path — no wildcards, no prefixes, ever. HTTPS is required, with a single carve-out: plain HTTP is permitted only for loopback (localhost / 127.0.0.1) so local development stays honest. Every change — add, edit, remove — is recorded as a first-class security audit event in the same surface as suspensions and credential rotations: a silent redirect-URI addition is a code-interception primitive, and "who added that URI, when" must always be answerable. The enforcement itself (comparing a live authorize request against the list) is exercised by ticket 09; this ticket delivers configuration and validation of the stored URIs.

**Blocked by:** 06 (Applications exist to configure).

**Status:** ready-for-agent

- [ ] An Owner can add, edit, and remove redirect URIs on an Application via the dashboard, through the Management API
- [ ] An invalid URI is rejected at submission: non-HTTPS scheme (except loopback), wildcard or prefix patterns, malformed components
- [ ] Plain HTTP is accepted only for loopback hosts; every other plain-HTTP submission is refused
- [ ] Exact-match semantics are the only matching mode; no prefix or pattern form is accepted by the configuration API
- [ ] Every change is an audit event recording who changed what, when — first-class, in the same surface as suspensions and credential events
- [ ] Black-box tests cover acceptance and rejection cases over HTTP only, including the loopback carve-out and audit assertions

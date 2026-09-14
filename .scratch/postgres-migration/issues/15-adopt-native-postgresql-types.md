# 15: Adopt native PostgreSQL types

**What to build:** The schema and live database move to native types: boolean for verification state, timezone-aware millisecond timestamps for every instant, JSONB for audit detail, and enums for administrator role, token kind, application type, and setting key. Superseded CHECK constraints are dropped; the email normalization CHECKs remain. Code comparisons and serialization are adapted so observable behavior — including ISO-8601 timestamps at the HTTP surface — is unchanged.

**Blocked by:** 10, 11, 12, 13, 14 (all typed conversions)

**Status:** done

- [x] Schema and database use boolean, timestamptz(3), jsonb, and enums; no integer-boolean or text-timestamp encodings remain
- [x] The migration is hand-reviewed: it drops only the superseded CHECKs and preserves the email CHECKs
- [x] Instant comparisons use native dates; HTTP payloads keep the same ISO-8601 format as before
- [x] Token expiry, audit windows, and single-use behaviors are unchanged
- [x] `npm run verify` is green

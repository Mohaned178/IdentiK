# 06: Settle secrets and the signing-key story

Type: grilling

Status: resolved

## Question

How are production secrets held and minted? The settled posture is one root-owned `0600` host `.env` consumed by compose, consistent with ADR-0022's deployment-held secrets — confirm the exact variable set, file location and permissions, and how secret rotation is handled (in particular: there is no safe rotation story for `IDENTIK_SIGNING_JWKS` yet, so state what rotation means or explicitly defer it).

Resolve the missing piece this map must not dodge: how the operator mints a stable `IDENTIK_SIGNING_JWKS` in the first place — a documented one-liner (key generation today exists only as a `jose` snippet inside e2e tests) versus a small keygen command shipped in the image. And record as inviolable that the `.env`, signing keys included, is in backup scope: losing the key set invalidates every Session and token.

## Answer

**Decided (all grilling recommendations approved), with one premise corrected on evidence:**

- **Rotation was never missing — only undocumented.** `signing-keys.service.ts` already implements first-signs / all-verify with a code comment describing the dance. The supported procedure is now stated: prepend the new private key → recreate → wait out the longest token TTL (refresh/session windows, ~30 days at defaults) → drop the old key → recreate. Emergency full replacement is documented as session-killing break-glass, not rotation.
- **Minting: a third entrypoint subcommand, `keygen`**, printing a fresh RS256 JWKS to stdout for pasting into `.env`. This amends the image decision's two-subcommand shape (flagged openly, pointer left on that ticket). Rationale: the capability lives in the artifact, identical for every operator, nothing to assemble — `jose` is already a production dependency, so no new packages.
- **File shape:** `deploy/.env` inside the pinned checkout, gitignored, root-owned `0600`. `DATABASE_URL` is built from the shared `POSTGRES_PASSWORD` by compose interpolation — one password secret, referenced twice, unable to disagree with itself. `IDENTIK_TEST_DATABASE_URL` is banned from the host by runbook statement.
- **Change semantics:** every secret change takes effect by service recreate, since configuration loads once at boot. Stated as a rule, matching the code.
- **Backup scope confirmed inviolable:** the `.env`, signing keys included, is backed up alongside the database dumps (mechanism owned by the backup ticket). Key loss is total, silent, unrecoverable session/token invalidation.
- **Placement confirmed:** required-for-live.

# 01: Enforce fail-closed configuration at startup

**What to build:** Startup evaluates one validated configuration contract before the Instance serves. Missing or invalid required settings exit the process with an actionable message naming the setting, never a silent default; the development-only fallbacks (ephemeral signing keys and the captured-mail binding) are refused unless the single explicit development opt-in is present. The example environment file documents the contract — required versus optional, the production-required signing key set, and the opt-in with its risks — and secrets stay deployment-held.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] Missing `DATABASE_URL`, `IDENTIK_BASE_URL`, `MAIL_TRANSPORT_BINDING`, or `IDENTIK_SIGNING_JWKS` (outside the development opt-in) exits non-zero with the setting named in the message.
- [x] The SMTP set (host, port, sender, and credentials as a pair) is validated together when the smtp binding is chosen; a partial set is refused.
- [x] A present-but-invalid duration, count, or port fails startup; absent optional values keep their documented defaults.
- [x] With the development opt-in set, ephemeral signing keys and the captured-mail binding are permitted; without it, both are refused.
- [x] The example environment file groups required versus optional settings, includes the sender address, and documents the opt-in as development/test-only.
- [x] New refusals are covered by spawn-based e2e assertions; the full suite stays green.

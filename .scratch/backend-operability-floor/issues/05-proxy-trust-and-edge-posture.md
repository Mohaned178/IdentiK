# 05: Honor proxy trust and set the browser edge posture

**What to build:** Behind a TLS-terminating proxy, the Instance derives the real client source only when explicitly told which proxies to trust (default: none), so throttling and audit show honest sources and direct spoofing fails. Responses carry a baseline security header set with HSTS only when the public origin is https, session cookies keep their existing posture, no CORS surface is added, and the Instance never redirects HTTP to HTTPS itself — the proxy owns TLS and redirects.

**Blocked by:** 01 — Enforce fail-closed configuration at startup

**Status:** done

- [x] The trust-proxy setting (default off) accepts loopback, hop-count, or CIDR values; a spoofed forwarded header changes nothing when off and is honored when configured.
- [x] The audit surface shows the derived client source.
- [x] Baseline security headers appear on responses; HSTS appears only under an https base URL.
- [x] Session cookie flags are unchanged (host-only, HttpOnly, Lax, Secure from the base URL); no CORS headers are emitted.
- [x] No application-level HTTP-to-HTTPS redirect exists.
- [x] Suite green.

## Comments

- `IDENTIK_TRUST_PROXY` accepts `loopback`, a hop count, a bare IP, or an IP/CIDR list. `true` and 0-length prefixes (`0.0.0.0/0`, `::/0`) are refused at startup because they would let any client forge the source that throttling and the audit surface depend on.
- HSTS and the cookie `Secure` flag derive from the parsed base URL (`isHttpsOrigin`), so scheme casing cannot silently disable either.
- The same-origin, no-CORS stance is documented in the spec; the operator-facing statement of it belongs to ticket 06 (the operator envelope).

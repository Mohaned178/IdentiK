# 06: Set the network-edge and browser security posture

**Type:** grilling
**Status:** resolved
**Blocked by:** 01, 02

## Question

What must the backend do to behave correctly behind a TLS-terminating reverse proxy and in a browser?

Facts: no `trust proxy` is set while throttling keys on `req.ip` (`authorize.controller.ts:60`, `administrators.controller.ts:101`, `end-users.controller.ts:219`, `account-center.controller.ts:116`) — behind a load balancer every source collapses to the proxy address. There is no CORS configuration, no security headers, and `X-Powered-By` is not suppressed. Cookies are `httpOnly`, `SameSite=Lax`, `secure` iff `IDENTIK_BASE_URL` starts with https (`config/cookies.ts:22-28`); there is no CSRF token while management and account endpoints change state via POST.

Settle: forwarded-header/trust-proxy policy and honest source-address derivation; CORS stance for same-origin first-party clients; baseline security headers; cookie attributes under TLS termination (`Secure`, `SameSite`, `__Host-`?); whether `SameSite=Lax` plus same-origin clients is an adequate CSRF story or tokens are required for the management surface; and how the public origin is configured (`IDENTIK_BASE_URL`). Depends on the deployment topology from ticket 02.

## Answer

**Forwarded headers (Q1).** A new `IDENTIK_TRUST_PROXY` setting with Express semantics — `false` (default), `loopback`, a hop count, or a CIDR list — matched by the operator to the proxy layout. Default off: no forwarded header is trusted unless told to be, so a directly reachable Instance cannot be spoofed. All six `req.ip` sites (throttle keys and audit source) inherit the derivation. Scheme and public origin stay defined by `IDENTIK_BASE_URL`, never by forwarded headers, and the app performs no HTTP→HTTPS redirect — the proxy owns TLS and redirects. This amends the "no new knobs" sentence of "Decide the production configuration contract", which covered the fixed constants it listed.

**CORS (Q2).** None. First-party clients are same-origin this release; a cross-origin dashboard would require `SameSite=None` cookies plus CSRF machinery and is a new decision for the frontend effort. Same-origin is documented as the supported shape.

**Security headers (Q3).** A minimal baseline on all responses: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, framing denied (`X-Frame-Options: DENY` plus `frame-ancestors 'none'`), `X-Powered-By` suppressed, and `Strict-Transport-Security` only when `IDENTIK_BASE_URL` is https. CSP waits until a frontend serves HTML and can own its headers.

**Cookies (Q4).** Keep today's posture: host-only (no `Domain`), `httpOnly`, `SameSite=Lax`, `Secure` from the configured base URL, `Path=/`. `__Host-` name prefixes are ruled out of this effort as optional polish (they would break dev-mode HTTP).

**CSRF (Q5).** `SameSite=Lax` plus same-origin clients plus POST-only state changes is the control. Cross-site POSTs arrive without the cookie and fail closed; the authorize GET is bounded by PKCE, exact-match redirect URIs, and first-party auto-enrollment (ADR-0014). CSRF tokens and origin-check middleware are ruled out, matching the C-tier ruling in "Define the backend completion bar"; revisit only if a client surface becomes cross-origin.


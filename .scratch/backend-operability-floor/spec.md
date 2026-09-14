# Backend Operability Floor — Production Readiness Before Dockerization

Status: ready-for-agent

## Problem Statement

The Instance is behavior-complete for the MVP — all 66 user stories are shipped and verified by the two-seam end-to-end suite — but it cannot yet be deployed as a production Instance with confidence.

Startup accepts a typo'd duration silently, an unset signing key silently produces an ephemeral key that invalidates every token on restart, and a captured-mail binding can mount an unauthenticated development surface anywhere. Health reports `ok` when PostgreSQL is unreachable. Migrations have a manual command but no deployment story an Instance Operator can follow from the release artifact. And nothing is defined for the most common production shape — the Instance behind a TLS-terminating reverse proxy: client sources collapse to the proxy address (weakening throttling and audit), cookie and header posture is unconsidered, and the public origin's trust assumptions are undocumented.

The Instance Operator cannot tell what "ready to deploy" means, so Dockerization would encode guesses. This spec is that missing definition, implemented.

## Solution

A bounded set of backend guarantees — the **deployable-Instance floor** — that makes the Instance production-operable without adding features:

- Fail-closed configuration: one boot-time validated schema; production refuses development fallbacks unless explicitly opted in.
- Honest health: liveness and readiness split, readiness gated on PostgreSQL, mail diagnostic only, and a readiness flip on shutdown so the drain is safe.
- A migration story: an explicit one-off deploy step, a pinned CLI shipped with the artifact, and a boot gate that refuses to serve against a database behind the release.
- A defined network edge: explicit proxy trust for honest client sources, no CORS, baseline security headers, and the existing cookie posture documented as the CSRF control.
- A locked topology: one Instance process against one PostgreSQL, documented, with PostgreSQL 18 and direct connections as the supported envelope.

The floor is the gate: Dockerization begins when this spec is implemented and the suite is green.

## User Stories

1. As an Instance Operator, I want startup to refuse to run when a required setting is missing, so that a misconfigured Instance never serves traffic.
2. As an Instance Operator, I want every refusal to name the setting and the fix, so that I can correct it without reading source.
3. As an Instance Operator, I want a typo'd duration or count to fail startup instead of silently becoming a default, so that configuration is trustworthy.
4. As an Instance Operator, I want production to require a stable signing key set, so that a container restart cannot invalidate every Session and token.
5. As an Instance Operator, I want production to refuse the captured-mail binding, so that the unauthenticated development mail surface can never exist in production.
6. As a developer, I want one explicit development opt-in, so that tests and demos can use ephemeral keys and captured mail without weakening production.
7. As an Instance Operator, I want one validated configuration schema covering every setting, so that there is a single documented contract.
8. As an Instance Operator, I want the SMTP settings validated as a set when the smtp binding is chosen, so that a half-configured relay fails at boot rather than at the first sign-up.
9. As an Instance Operator, I want the sender address required by the docs to actually be documented, so that following the example produces a working relay.
10. As an Instance Operator, I want the listen port to default to 3000 but be validated when set, so that I cannot serve on nonsense.
11. As an Instance Operator, I want the example environment file to separate required from optional settings, so that I can provision from it directly.
12. As an Instance Operator, I want secrets to stay deployment-held, never movable from the dashboard, so that compromising an Administrator cannot compromise the trust fabric (ADR-0022).
13. As an Instance Operator, I want a liveness endpoint that reports the process alone, so that my orchestrator does not restart an Instance whose database is briefly slow.
14. As an Instance Operator, I want a readiness endpoint that reports PostgreSQL, so that traffic stops when the database is unreachable.
15. As an Instance Operator, I want readiness to answer 503 when the database is unreachable, so that load balancers and orchestrators act without parsing bodies.
16. As an Instance Operator, I want mail-relay reachability reported without blocking readiness, so that a flaky relay is visible but not treated as an outage.
17. As an Instance Operator, I want health responses to expose no hosts, error text, or timestamps, so that unauthenticated endpoints reveal nothing.
18. As an Instance Operator, I want `/health` to keep answering as a readiness alias, so that existing probes and documentation keep working.
19. As an Instance Operator, I want readiness to fail the moment shutdown begins, so that a draining Instance stops receiving new work.
20. As an End User, I want in-flight requests to finish during a restart, so that a deployment never cuts my request mid-flight.
21. As an Instance Operator, I want health to answer quickly under a bounded probe, so that container health checks neither hang nor flap.
22. As a Maintainer, I want the test harness to probe the readiness endpoint, so that the suite exercises the contract deployment uses.
23. As an Instance Operator, I want migrations to be an explicit step separate from server start, so that a restart can never race a schema change.
24. As an Instance Operator, I want the migration CLI shipped with the artifact and exact-pinned, so that I can migrate even without registry access.
25. As an Instance Operator, I want the server to refuse to start when the database is behind this release, so that I can never serve against a stale schema.
26. As an Instance Operator, I want the refusal to name the migration command, so that remediation is copy-paste.
27. As an Instance Operator, I want a database ahead of the app to be tolerated, so that a rollback across additive migrations stays safe.
28. As an Instance Operator, I want concurrent migration attempts serialized, so that two deploys cannot corrupt migration bookkeeping.
29. As an Instance Operator, I want one database role to work by default, with a documented split-role pattern when I want it, so that setup stays simple without capping my security posture.
30. As a Release Manager, I want the artifact to fail loudly when its migrations are missing, so that a broken release never starts.
31. As an Instance Operator, I want a single documented topology — one Instance process against one PostgreSQL — so that I can size my deployment without guessing.
32. As an Instance Operator, I want multiple replicas explicitly unsupported and documented, so that I do not assume an unkept promise.
33. As an Instance Operator, I want to state which proxies are trusted, so that client sources behind my reverse proxy are honest.
34. As an Instance Operator, I want the trust default to be nothing, so that a directly reachable Instance cannot have its sources spoofed.
35. As an Administrator, I want throttling and the audit surface to see the real source, so that credential campaigns are visible and investigable.
36. As an Instance Operator, I want TLS termination to stay at my proxy, so that the Instance carries no certificate handling.
37. As an Instance Operator, I want baseline security headers on every response, so that browsers apply safe defaults.
38. As an Instance Operator, I want HSTS only when my public origin is https, so that development over HTTP stays honest.
39. As an End User, I want my Session cookie to remain host-only, HttpOnly, Lax, and Secure under HTTPS, so that it is protected by default.
40. As an Administrator, I want cross-site POSTs to my management actions to fail closed, so that a malicious page cannot act as me.
41. As an Instance Operator, I want no CORS surface this release, so that every client is same-origin and the cookie posture stays strict.
42. As an Instance Operator, I want PostgreSQL 18 documented as the supported database, so that I bring the tested version.
43. As an Instance Operator, I want transaction-mode poolers documented as unsupported, so that I do not front the database with a configuration the platform does not test.
44. As a Maintainer, I want the floor verified by the existing black-box suite, so that every claim in this spec is executable rather than aspirational.
45. As a Maintainer, I want the floor frozen as the gate before Dockerization, so that packaging starts from a known base with no backend decisions left open in its scope.

## Implementation Decisions

### Scope: the floor is the completion bar

- This spec implements the resolved deployable-Instance floor: fail-closed configuration, honest health, migration sequencing, edge posture, and the locked topology. It is the gate before Dockerization; the wayfinder map's remaining open decisions are out of scope and listed below.

### Fail-closed configuration

- One validated configuration schema is evaluated at startup before the HTTP listener binds. A missing or invalid value exits the process non-zero with an actionable message naming the setting; nothing is silently defaulted when present but invalid.
- Required always: `DATABASE_URL` (absolute PostgreSQL URL with host and database), `IDENTIK_BASE_URL`, `MAIL_TRANSPORT_BINDING`.
- Required unless the development opt-in is present: `IDENTIK_SIGNING_JWKS` (a private signing key set).
- Required when the smtp binding is chosen: `SMTP_HOST`, `SMTP_PORT`, `MAIL_FROM`, with `SMTP_USER`/`SMTP_PASSWORD` supplied as a pair; `SMTP_SECURE` and `SMTP_REQUIRE_TLS` keep documented optional defaults.
- `PORT` is optional with the 3000 default and must be a valid TCP port when set.
- Optional durations and counts (token/session TTLs, throttle thresholds) keep their documented defaults when absent; present-but-invalid values are fatal rather than clamped.
- Development opt-in: `IDENTIK_DEV_MODE=1` permits ephemeral signing keys and the captured-mail binding. Without it, both are startup refusals. The opt-in is documented as development/test only.
- `IDENTIK_TRUST_PROXY` is the only new tunable (see edge posture below).
- No other hardcoded operational values become configurable: the Administrator session TTL, cookie names, and the mail-reachability cache stay fixed.
- The example environment file is regrouped: `MAIL_FROM` added, required versus optional marked, the production-required signing key set called out, and the development opt-in documented with its risks. It remains documentation, not a loader. Secrets stay deployment-held (ADR-0022).

### Health and readiness

- `GET /health/live` → `{ "status": "ok" }`, 200 while the process serves.
- `GET /health/ready` → `{ "status": "ok" | "degraded" | "unavailable", "checks": { "database": { "ok": boolean }, "mail": { "binding": string, "reachable": boolean } } }`, answered 200 for `ok` and `degraded`, 503 for `unavailable`.
- `GET /health` remains an alias of readiness.
- Readiness gates on an uncached database connectivity probe with a short timeout (≤2s). The migrated-schema check stays a startup gate, not a per-probe check.
- Mail is diagnostic per ADR-0020's posture from the SMTP-binding work: an unreachable relay yields `degraded`, never 503. The existing 5s reachability cache stays, and no relay endpoint or error text is exposed.
- On SIGTERM, readiness reports `unavailable` immediately; the process drains in-flight requests up to ~10s; liveness answers until the process exits; the data client's existing shutdown path disconnects the pool.
- Both health endpoints stay unauthenticated and carry nothing sensitive.

### Migrations

- The server never applies migrations. The deploy sequence is: run the migration step, then replace/start the server.
- The migration step is explicit and one-off, run from the release artifact. Dockerization may wrap it as a one-off command or job from the same artifact — never on server start.
- The Prisma CLI becomes a production dependency, exact-pinned to the same major as the runtime client. The tarball keeps the documented pinned `npx` fallback because it ships without `node_modules`.
- The startup gate compares the migrations shipped in the artifact with the database's migration bookkeeping and refuses to start when the database is behind the release, naming the migration command. A database ahead of the app (a rollback across additive migrations) is allowed. A runtime artifact missing its migrations directory is a startup failure.
- One database role is the supported default. Because each step supplies its own `DATABASE_URL`, a privileged-migrate/restricted-runtime split needs no product support and is documented as an operator-side pattern; no second variable is introduced.
- Concurrent migration attempts are serialized by Prisma's advisory lock; at the supported single-replica topology no additional machinery is added.

### Network edge and browser posture

- `IDENTIK_TRUST_PROXY` accepts Express trust-proxy semantics — `false` by default, or `loopback`, a hop count, or a CIDR list. Every throttle key and audit source derives from the same client-address resolution; an absent source contributes no throttle dimension.
- No in-app HTTP→HTTPS redirect: the proxy owns TLS and redirects. `IDENTIK_BASE_URL` defines the public origin, including whether cookies are `Secure`.
- No CORS configuration: all first-party clients are same-origin this release. A cross-origin client would require a cookie/CSRF redesign and is a future decision.
- Baseline security headers on every response: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, framing denied (`X-Frame-Options: DENY` and a `frame-ancestors 'none'` policy), `X-Powered-By` suppressed, and `Strict-Transport-Security` only when `IDENTIK_BASE_URL` is https.
- Cookie posture is unchanged: host-only (no `Domain`), HttpOnly, `SameSite=Lax`, `Secure` from the configured base URL, `Path=/`.
- The CSRF control is `SameSite=Lax` plus same-origin clients plus POST-only state changes. CSRF tokens and origin-check middleware are not required under the completion bar.

### Topology and database support

- The supported shape is exactly one Instance process against one PostgreSQL. Multiple replicas and overlapping process lifetimes are unsupported and documented, not enforced.
- PostgreSQL 18 is the only supported version (the one CI proves); older majors are documented as untested, with no runtime version gate.
- Direct connections are supported; transaction-mode poolers are untested, documented as unsupported, and require no pooler-specific configuration.

## Testing Decisions

- **What makes a good test**: black-box only, at the project's two existing seams — the instance HTTP surface and captured email — plus the process-start observability already used for SMTP misconfiguration (spawn the built Instance, observe exit and message). No test inspects storage, token internals, or module structure. No unit tier is added; the whole Instance remains the unit under test.
- **Configuration refusals**: spawning with a missing signing key set, an invalid duration, an invalid port, an incomplete SMTP set, or `capture` without the development opt-in exits non-zero with a message naming the setting; the same environment with the opt-in boots and serves.
- **Health semantics**: liveness answers while serving; readiness reports `degraded` with an unreachable relay; readiness answers 503 when the database becomes unreachable (interrupted through the harness's administrative provisioning) and recovers; `/health` answers as the readiness alias.
- **Shutdown**: after SIGTERM, an in-flight request completes, readiness reports `unavailable`, and the process exits within the drain bound.
- **Source keying**: with trust-proxy configured, a forwarded client address appears in the audit surface's source (read through the management API); with the default off, a spoofed forwarded header does not change it.
- **Headers and cookies**: responses carry the baseline headers; HSTS appears only under an https base URL; session cookies keep the decided flags.
- **Migrations**: starting against a database provisioned to an earlier migration state is refused with the migration command in the message; a database carrying an applied migration unknown to the spawned artifact (provisioned by spawning against a copy of the artifact whose migrations directory omits it) is tolerated; a spawn without a migrations directory fails.
- **Prior art**: the walking-skeleton boot/health test, the SMTP-binding startup-refusal and diagnostics tests, the throttling and audit-surface tests, and the harness's migrate-and-provision pattern.
- The existing suite stays green — `npm run verify` remains the release gate for this work.

## Out of Scope

- **The wayfinder map's open decisions**, which may amend this spec as they resolve: abuse-protection coverage beyond source keying, Management API completeness for the dashboard, the unified error and validation contract, session/token concurrency edge cases, the verification bar's refinements, operator-lifecycle guarantees, the observability floor, and the client-surface freeze policy.
- **Deferred capabilities** per the MVP spec and ADRs: TOTP MFA and recovery codes, social login / External Identity federation, machine-to-machine Applications and programmatic Management API access, consent screens and third-party Applications, Application environments, hosted multi-tenant mode, application role storage, impersonation, SMS/email-OTP factors, hard lockout, and logout propagation.
- **Hardening beyond the floor**: multi-replica support, shared or persistent throttle state, signing-key rotation tooling, audit retention and archival tooling, metrics/tracing or an observability stack, `__Host-` cookie prefixes, CSRF token machinery, OpenAPI publication, a unit-test tier, branding asset upload, Administrator session TTL configurability, and invitation listing/revocation.
- **Not this effort**: Docker artifacts (Dockerfile, compose, images, entrypoint, registry) and the frontend implementation — the next efforts this floor prepares.
- **Data lifecycle sweeps** for expired mailbox proofs, codes, and Sessions (lazy expiry remains as today).

## Further Notes

- This spec realizes the resolved decisions of the wayfinder map **Backend completion before Dockerization** (`.scratch/backend-completion/map.md`): its completion-bar, topology, configuration, health, migration, and edge-posture tickets. Open tickets on that map remain the route forward and may amend this spec; Dockerization follows once the map's required set is exhausted.
- Relevant ADRs: 0001 (self-hosted first, Organization tenancy), 0020 (uniform messaging, throttling, no lockout), 0022 (instance versus Organization settings), 0026 and 0027 (PostgreSQL and Prisma). No ADR is contradicted; the PostgreSQL migration's deliberate deferral of database health checks is now resolved by the health decision here.
- The development opt-in is the single deliberate seam that lets tests and demos run the insecure fallbacks; every other path is production-strict by default.

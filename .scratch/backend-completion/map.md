# Backend completion before Dockerization

## Destination

A locked, recorded definition of what "backend complete enough to begin Dockerization" means for IdentiK — the release gate — with every required backend decision resolved on this map, optional improvements explicitly ruled in or out, and nothing left to decide before the Dockerization effort starts. This map produces decisions, not code.

## Notes

- Authority documents: `CONTEXT.md`, `docs/adr/0001`–`0027`, the MVP spec (`.scratch/identity-platform-mvp/spec.md`), and the PostgreSQL + Prisma migration spec (`.scratch/postgres-migration/spec.md`). Read the ADRs touching an area before deciding it; flag conflicts rather than silently override them.
- Planning only: every ticket resolves a decision. No implementation happens in this effort.
- Judge requirements from this project's own domain model, MVP scope, and ADRs — never from Clerk/Auth0 feature parity.
- Do not revisit architecture candidates #3–#6 unless a ticket proves one is required for this destination.
- HITL tickets resolve with the human: call the Skill tool for `grilling` and `domain-modeling`. Research tickets resolve AFK via the `research` skill.
- The completion bar is settled: **B — the deployable-Instance floor** (decision in "Define the backend completion bar"). Hardening beyond the floor is out of scope unless a required ticket proves it necessary.

## Decisions so far

- [Define the backend completion bar](issues/01-define-backend-completion-bar.md): Bar = **B, the deployable-Instance floor** — spec-shipped behavior plus validated production configuration, DB-aware readiness, sequenced migrations shipped in the artifact, proxy-correct edge behavior, and a story-complete Management API with a usable error contract. The full hardening backlog is ruled out of this effort.

- [Lock the deployment topology assumption](issues/02-lock-deployment-topology.md): One Instance process against one PostgreSQL — multi-replica and overlapping lifetimes unsupported (documented, not enforced); restarts drain in-flight requests up to ~10s; PostgreSQL 18 only via direct connection, poolers unsupported.

- [Decide the production configuration contract](issues/03-production-configuration-contract.md): Fail-closed by default — production-strict unless `IDENTIK_DEV_MODE=1`; one boot-time validated schema; missing or invalid values are fatal, never silently defaulted; no new tunables; `.env.example` documents the contract.

- [Define the health and readiness contract](issues/04-health-and-readiness-contract.md): Split `/health/live` and `/health/ready` (`/health` aliases readiness); readiness gates on a short uncached PostgreSQL probe (503 when down), mail degrades but never gates; coarse public bodies; readiness flips on SIGTERM ahead of the drain.

- [Sequence database migrations for deployment](issues/05-migration-deployment-sequencing.md): Migrations are an explicit one-off step (never at server start), serialized by Prisma's advisory lock; the CLI ships exact-pinned as a production dependency, `npx prisma@7.10.0` stays the tarball fallback; one database role by default; startup detects pending migrations and refuses to serve.

- [Set the network-edge and browser security posture](issues/06-network-edge-security-posture.md): Explicit `IDENTIK_TRUST_PROXY` (default off) for honest client-source derivation; no CORS (same-origin clients only); minimal security headers with HSTS only under an https base URL; existing cookie posture kept; `SameSite=Lax` plus same-origin clients is the CSRF control.

<!-- one line per closed ticket: the gist, then the link to the ticket that holds the detail -->

## Not yet specified

- **Data lifecycle and cleanup.** Expired mailbox proofs, verification/reset/email-change tokens, authorization codes, idle Sessions, unverified reservations, and anonymized shells expire lazily and are never swept (`mailbox-proof.service.ts`, `sessions.service.ts`). Is lazy expiry sufficient indefinitely, or does completion require a scheduled sweep — and if so, where does it live?
- **Hosted-page and Account Center data-contract completeness.** How much page-data shape the upcoming frontends need beyond story-mandated behavior; sharpens once the client-surface freeze policy and the Management API survey land.

## Out of scope

- **Deferred capabilities (settled by spec and ADRs, post-MVP additive increments):** TOTP MFA + recovery codes (ADR-0017); social login / External Identity federation (ADR-0012); machine-to-machine Application type and programmatic Management API access; consent screens and third-party Applications (ADR-0014); Application environments; hosted multi-tenant mode (ADR-0001); Application role/permission storage; impersonation; SMS/email-OTP factors; hard lockout (ADR-0020); front/back-channel logout propagation.
- **Hardening beyond the deployable floor (bar = B):** multi-replica support, shared/persistent throttle state, signing-key rotation tooling, audit retention/archival tooling, metrics/tracing or an observability stack, and the optional-polish candidates (OpenAPI publication, a unit-test tier, branding asset upload, Administrator session TTL configurability, invitation listing/revocation, `__Host-` cookie prefixes, CSRF token machinery). An item returns only if a required ticket proves it necessary for the floor.
- **Not this effort (the next efforts this map prepares):** Docker artifacts themselves — Dockerfile, compose, images, entrypoint, registry — and the frontend/dashboard implementation.
- **Parked architecture candidates #3–#6:** revisited only if a ticket here proves one required for the destination.

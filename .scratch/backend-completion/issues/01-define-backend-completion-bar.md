# 01: Define the backend completion bar

**Type:** grilling
**Status:** resolved
**Blocked by:** none

## Question

What must be true of the backend for it to count as complete enough to begin Dockerization? The MVP's 66 user stories are shipped and verified (21 tickets, 23 e2e files, `npm run verify` green), so the answer is not "more MVP features" — it is where the bar sits between "shipped" and "deployable Instance". Three readings:

- **A — Spec-shipped only.** The MVP spec is the contract; the backend is done; Dockerization is pure packaging. Tickets 02–13 mostly become out of scope.
- **B — Deployable-Instance floor.** A plus what a containerized, production-operated Instance needs before packaging is meaningful: fail-fast validated configuration and production-mode refusal of dev fallbacks (ephemeral signing keys, capture mail); a PostgreSQL-aware health/readiness surface; a documented migration sequencing story with schema and migrations shipping in the artifact; correct behavior behind a TLS-terminating reverse proxy (forwarded headers, honest source keying, secure cookies); and the Management API exposing what the dashboard stories demand.
- **C — Release-hardened.** B plus the hardening backlog: observability stack, CSRF tokens beyond cookie posture, shared/persistent throttle state, multi-replica support, signing-key rotation tooling, audit retention.

Sub-questions the answer must settle:

1. Where does the boundary between backend completion and Dockerization work fall (e.g., is a migrations entrypoint backend work or packaging work)?
2. How frozen must the client surfaces be — may UI-driven API refinement happen during frontend work, or must the Management API be complete now?
3. Which of tickets 02–13 are required, which are optional, and which are ruled out of scope entirely?

Deliverable: the recorded bar. It completes this map's Destination and freezes the required set.

## Answer

**Bar: B — the deployable-Instance floor.** "Backend complete enough for Dockerization" means:

- the MVP's 66 user stories stay shipped and verified at the two seams, unchanged;
- production configuration is validated at startup and refuses dev-only fallbacks (ephemeral signing keys, capture mail);
- the health/readiness surface reports PostgreSQL and the migrated schema honestly;
- migrations have a documented, sequenced deploy story and ship in the release artifact;
- edge behavior is correct behind a TLS-terminating reverse proxy (forwarded headers, honest source keying, secure cookies);
- the Management API exposes what the dashboard stories demand, with a usable error and validation contract.

**Ruled out of this effort** (C-tier hardening, per the bar): multi-replica support, shared/persistent throttle state, signing-key rotation tooling, audit retention/archival tooling, metrics/tracing or an observability stack, and the optional-polish candidates. An item may be pulled in only if a required ticket proves it necessary for the floor.

**Sub-questions settled:**

1. **Boundary:** configuration, health, migrations (the documented story and artifact contents), proxy correctness, and client-surface completeness are backend completion; container entrypoint mechanics and packaging are Dockerization work, decided jointly in "Sequence database migrations for deployment".
2. **Required set:** tickets 02–13 stay as decisions, narrowed by the floor — "Harden abuse-protection state for the deployment", "Set the operator-lifecycle guarantees", and "Set the observability floor" decide only the floor; their C-tier variants are out of scope.
3. **Freeze policy:** not settled here — graduated to **Freeze the client-surface contract**, which blocks "Close the Management API gaps the dashboard needs".

**Rejected:** A (spec-shipped only — lets a containerized Instance fail in production for packaging-time surprises); C (release-hardened — buys the backlog before the product is deployable).


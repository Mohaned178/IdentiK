# 01: Define the production image

Type: grilling

Status: resolved

## Question

What exactly goes into the production Docker image, given the settled shape — one multi-stage image (build: `npm ci`, `prisma generate`, `nest build`; runtime: `dist`, production `node_modules` with the exact-pinned Prisma CLI, the `prisma/` migrations directory the boot gate requires) with `server` and `migrate` entrypoint subcommands?

Resolve: base image (slim vs distroless vs other) with rationale, runtime user (non-root expectations), which architectures are built, whether a `HEALTHCHECK` lives in the image or only in compose, what the build context excludes, and confirm the image keeps the floor's artifact rules (migrations present, CLI exact-pinned, `npx prisma@<pinned>` fallback intact for the tarball). The GitHub tarball keeps shipping unchanged for non-Docker operators.

## Answer

**Decided (all grilling recommendations approved):**

- **Base: `node:24-slim`, exact-pinned minor, multi-stage; runtime as the image's built-in non-root `node` user.** Alpine ruled out on evidence: Prisma 7's schema-engine binaries (`@prisma/engines`, pulled per-platform by `npm ci`) need glibc + OpenSSL, and the image must run the pinned `migrate`. Distroless deferred as polish — it sheds the shell the entrypoint wrapper and on-box inspection need.
- **Architectures: `linux/amd64` only.** Per-arch `npm ci` under buildx would handle the engines correctly, but arm64 doubles build complexity for hardware the operator doesn't have; it graduates when hardware demands it. Constraint recorded: a `node_modules` layer must never be shared across arches — it would poison the engine binaries.
- **No in-image `HEALTHCHECK`.** The probe lives exactly once in compose (ticket 02), which already owns the liveness semantics; the image stays environment-agnostic.
- **Runtime stage does a fresh prod-only `npm ci --omit=dev`** (not copy-and-prune) — cleanest, exact, per-arch-correct engines. Build stage keeps the full install for `prisma generate` + `nest build`. Build context excludes the usual (`node_modules`, git, e2e, scratch, docs) — detail for the execution effort.
- **Entrypoint is a small shell wrapper** with `server` (default → `node dist/main.js`) and `migrate` (→ pinned `prisma migrate deploy`) subcommands, so the runbook calls `run --rm app migrate` and the floor's migrate-is-explicit rule is structural, not conventional.
- **Floor artifact rules confirmed unchanged:** migrations directory and exact-pinned CLI inside the image; `npx prisma@<pinned>` fallback intact; GitHub tarball keeps shipping as-is for non-Docker operators.

*(Amendment, decided on the secrets ticket: the entrypoint gains a third subcommand, `keygen`, printing a fresh RS256 JWKS — see that ticket for the rationale.)*

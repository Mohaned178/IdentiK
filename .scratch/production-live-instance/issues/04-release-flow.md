# 04: Extend the release flow with the image

Type: grilling

Status: resolved

Blocked by: 01

## Question

Given the defined image (ticket 01), how does the existing tag-driven release (`v*.*.*` → `npm run verify` → GitHub Release) gain image publishing — build the multi-arch image in the release workflow, push version-tagged to GHCR, and keep the tarball shipping unchanged?

Resolve: the exact tag policy (version tags, short-SHA tags, whether any floating tag exists and the rule that deploys never use it), what verification the image itself gets in CI beyond the source gate (if any), provenance/attestation strictness, and registry permissions. Confirm placement: required-for-live.

## Answer

**Decided (all grilling recommendations approved). Correction carried from the session: the ticket body says "multi-arch" — superseded by ticket 01, the release builds amd64-only.**

- **Tag policy:** push the version tag (`vX.Y.Z`, from the git tag) plus a short-SHA tag to `ghcr.io/mohaned178/identik`. No floating tag is published at all — no `latest` exists to be deployed by mistake. The image digest is recorded in the GitHub Release notes alongside the tarball checksum.
- **Image self-verification:** beyond the source `verify` gate, the pipeline asserts the built image itself before push — migrations directory present, Prisma CLI version exactly the pinned one. The source gate proves the code; only this proves the artifact, at the exact point the floor's guarantees would silently break.
- **Provenance:** build-provenance attestation attached to every pushed image (needs `id-token:write`), so "the same image CI tested" is verifiable, not asserted.
- **Build on PRs:** image builds (no push) on pull requests touching backend/Dockerfile paths — Dockerfile rot breaks the PR, not release night.
- **Pipeline order, strict:** verify → build → image assertion → push → tarball → GitHub Release; any failure stops everything before it. A release is atomic or it isn't one.
- **Registry permissions:** `GITHUB_TOKEN` with `packages:write` (+ `id-token:write` for attestation). No PAT, no new secrets.
- **Placement confirmed:** required-for-live. Tarball shipping unchanged.

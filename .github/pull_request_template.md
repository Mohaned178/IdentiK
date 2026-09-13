## Summary

<!-- What does this change do, and why? One or two sentences a reviewer can hold in their head. -->

## Ticket / spec

<!--
Link the work: `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, or the spec.
Use the domain vocabulary from CONTEXT.md. Write N/A for a pure chore.
-->

## Changes

<!--
Bullet the notable changes. Be detailed: a reviewer should understand the scope
without reading every line of the diff. Call out schema, API, or security-boundary
changes explicitly.
-->

-

## Verification

<!-- Commands run and their outcome. Paste failures, not just the happy path. -->

- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `npm run test -w e2e`

## Checklist

- [ ] Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) and carry a detailed body where the change warrants one.
- [ ] Documentation updated where vocabulary or a decision changed (`CONTEXT.md`, `docs/adr/`, or the relevant `.scratch/` ticket).
- [ ] No secrets, credentials, or `.env` values are committed.
- [ ] New behaviour is covered by an end-to-end test at the HTTP/seam boundary.

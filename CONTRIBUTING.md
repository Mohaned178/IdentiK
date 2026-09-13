# Contributing

Thanks for helping build the Identity Platform. This guide covers how work moves
from an idea to `main`. For what the words mean, read [`CONTEXT.md`](CONTEXT.md)
first — it is the single authority on domain vocabulary, and every commit,
ticket, and test is expected to speak it.

## Prerequisites

- **Node.js 24** — pinned in [`.nvmrc`](.nvmrc). Run `nvm use` if you have it.
- **npm** — the repository is an npm workspace (`backend` and `e2e`).

```sh
npm ci          # install every workspace from the lockfile
npm run dev     # start the backend in watch mode
```

## Repository layout

```
backend/          NestJS service — the only deployable artifact
e2e/              Vitest end-to-end tests that drive a live Instance over HTTP
.scratch/         Specs and implementation tickets (the local issue tracker)
docs/adr/         Architecture Decision Records
CONTEXT.md        Domain glossary
```

## Checks

Run these before opening a pull request; CI runs exactly the same set.

```sh
npm run typecheck        # tsc --noEmit across both workspaces
npm run build            # nest build the backend into backend/dist
npm run test -w e2e      # end-to-end tests (builds the backend first)
npm run verify           # all three, in order
```

New behaviour is covered by an end-to-end test at the HTTP seam, not a unit test
of an internal. The seams are documented per ticket in `.scratch/`.

## Branches

Name a branch after the ticket it implements, so the branch and the tracker
point at each other:

```
ticket-06-application-registration        # a numbered ticket from .scratch
fix/redirect-uri-trailing-slash           # an unplanned fix
docs/contributing                           # documentation only
```

## Commits

This repository follows [Conventional Commits](https://www.conventionalcommits.org/).
CI enforces the format (`.github/workflows/commitlint.yml`); the rules below
explain the intent behind it.

```
<type>(<optional scope>): <subject>

<body>

<optional footer>
```

| Type       | Use for                                                        |
| ---------- | -------------------------------------------------------------- |
| `feat`     | A new capability a user or integrator can observe.             |
| `fix`      | A defect fix.                                                  |
| `refactor` | A change that neither adds behaviour nor fixes a bug.          |
| `perf`     | A performance improvement.                                     |
| `test`     | Tests only.                                                    |
| `docs`     | Documentation, tickets, ADRs, comments.                        |
| `build`    | Build tooling, dependencies, packaging.                        |
| `ci`       | Continuous-integration configuration.                          |
| `chore`    | Anything else that does not touch production behaviour.        |
| `revert`   | Revert of an earlier commit.                                   |

**Write detailed commits.** The subject says what changed; the body says why and
what a reviewer should know. For anything beyond a trivial change, include a
body that covers:

- the behaviour or invariant that changed, in domain terms;
- the security or data-boundary implications, if any;
- the trade-off or alternative you rejected, if the choice was not obvious.

Wrap the body at 100 columns, leave a blank line after the subject, and reference
tickets with `Refs: .scratch/<feature-slug>/issues/<NN>-<slug>.md`.

Example:

```
feat(applications): issue Client Secrets per labeled credential

A Web Application can now hold several concurrent labeled secrets so an
operator can rotate with zero downtime and identify a leaked credential.

Registration and the first secret are written in one transaction, so a Web
Application is never left half-registered without the credential that makes
it useful. SPA/Mobile registrations still receive no secret.

Refs: .scratch/identity-platform-mvp/issues/06-application-registration-credentials.md
```

Prefer a series of small, self-describing commits over one large commit: each
should build and pass the tests on its own where practical.

## Pull requests

1. Branch from `main` and keep the branch focused on one ticket.
2. Make sure `npm run verify` passes locally.
3. Open the pull request using the template. Fill in the ticket link, the
   changes, and the verification you ran.
4. Address review comments with new commits rather than force-pushes, so the
   history shows how the change evolved.
5. A pull request merges once CI is green and a reviewer has approved.

## Issues and specs

Feature work is **not** tracked in GitHub Issues. Specs and tickets are local
markdown under `.scratch/<feature-slug>/`:

- the spec is `.scratch/<feature-slug>/spec.md`;
- tickets are one file per item, `.scratch/<feature-slug>/issues/<NN>-<slug>.md`.

See [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md) for the full
convention. GitHub issue templates exist for bug reports and open-ended feature
requests; once a request becomes planned work, it moves into `.scratch/`.

## Decisions and vocabulary

- If a change introduces or redefines a domain term, update
  [`CONTEXT.md`](CONTEXT.md) in the same pull request.
- If it makes a decision that is hard to reverse or surprising later, add an ADR
  under [`docs/adr/`](docs/adr/), following the existing numbering and format.

## CI and releases

- **`.github/workflows/ci.yml`** — typecheck, build, and end-to-end tests on
  every push and pull request.
- **`.github/workflows/commitlint.yml`** — validates commit messages on pull
  requests against [`commitlint.config.mjs`](commitlint.config.mjs).
- **`.github/workflows/release.yml`** — on a `v*.*.*` tag, re-runs the full
  suite, packages the built backend, and publishes a GitHub Release with
  generated notes.

To cut a release, tag `main` (`git tag v0.2.0 && git push origin v0.2.0`). The
release workflow does the rest.

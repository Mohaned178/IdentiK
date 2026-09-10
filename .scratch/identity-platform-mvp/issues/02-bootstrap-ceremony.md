# 02: Bootstrap Ceremony — default Organization, first Owner, dedicated Administrator sign-in

**What to build:** On first boot of a fresh Instance, a one-time, expiring Bootstrap Ceremony flow establishes the default Organization and its first Owner — nobody invites the first Administrator; the Instance does. The ceremony begins from the installation process, and if it is not completed within its expiry window it can never be claimed by a later visitor. Once bootstrapped, the Owner signs in through a dedicated Administrator sign-in (ADR-0002: a separate population from End Users, with its own credential store and session type — no shared login path, ever) and lands in a minimal dashboard shell for their Organization. The audit store is born here: the completed bootstrap is the first audit event. All Administrator passwords are stored in verifiable form only.

**Blocked by:** 01 (walking skeleton).

**Status:** ready-for-agent

- [ ] First boot of a fresh Instance surfaces the one-time setup flow, initiated from the install process
- [ ] Completing the ceremony creates the default Organization and the first Owner (self-chosen password, stored verifiable-only)
- [ ] The setup flow expires: an untouched Instance past its expiry window cannot be claimed, and the expiry is enforced without an Administrator existing
- [ ] A completed bootstrap cannot be re-run; second visit to the setup route is refused
- [ ] The Owner signs in via a dedicated Administrator sign-in distinct from any End-User flow, and receives an Administrator session (separate session type)
- [ ] A minimal dashboard shell renders for the signed-in Owner, scoped to their Organization
- [ ] The audit store exists and records the completed bootstrap (who/what/when)
- [ ] Administrator credentials never exist in recoverable form
- [ ] Black-box tests cover: ceremony happy path, expiry, re-run refusal, Owner sign-in success and failure — all over HTTP only

# 01: Walking skeleton — bootable Instance + black-box test harness

**What to build:** From a clean checkout, the platform Instance builds and boots, and the test harness can drive it. The harness is the repository's testing pattern made real: every test talks to a live Instance exclusively through the two seams — its HTTP surface (OIDC protocol endpoints and the Management API) and a captured email transport — never inspecting databases, token internals, or module structure. This ticket delivers no product behavior; it delivers the skeleton every later ticket hangs from, plus the in-memory email capture binding so mailbox-proof flows (verification, reset, invitation) are testable from ticket 03 onward.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] A clean checkout builds and boots one Instance with a single command; health is observable over HTTP (`npm install && npm run verify`; `npm start`; GET /health)
- [x] The test harness starts an Instance per test run (isolated state between runs) without manual setup
- [x] Tests interact with the Instance only via its HTTP surface; no test inspects storage, token internals, or module structure
- [x] An in-memory email capture binding exists at the outbound mail boundary; a test can request an email be sent and assert on what was captured (recipient, subject, link)
- [x] The SMTP transport is bound behind an interface so the production binding (ticket 20) can replace it without touching callers
- [x] The fixed stack is in place: NestJS + TypeScript end to end
- [x] CI (or the local equivalent) runs the suite green (`npm run verify` = typecheck + build + e2e)

## Comments

Review round applied: the harness now owns the Bootstrap Ceremony's console reveal — `Instance.setupToken()` reads the one-time token the install process prints, with the seam documented in one place. Every later test dropped its copy-pasted scraping block; `bootstrap-ceremony.test.ts` keeps its explicit log assertions because the reveal is what it tests.

# 07: Harden abuse-protection state for the deployment

**Type:** grilling
**Status:** claimed
**Blocked by:** 02, 06

## Question

Is the in-memory throttle acceptable for the supported deployment, and what source does it key on?

Facts: `ThrottleService` is an in-process `Map`, delay-only, wiped by restart, per-replica inconsistent (`throttle/throttle.service.ts:47-55,66-78`). The PostgreSQL migration deliberately left it untouched; ADR-0020 requires per-source and per-Identity escalation with no hard lockout. Source keying currently uses `req.ip` (see ticket 06).

Settle: accept in-memory state for a single-replica Instance with a documented restart caveat, or persist/share it (and with what store); how the source dimension is derived behind the proxy (from ticket 06); which abuse surfaces are unthrottled and need coverage (verification/resend, invitation, token, introspection, userinfo, dev mail); and whether failed-attempt auditing has requirements under throttling. Depends on topology (02) and source derivation (06).

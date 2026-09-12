# 20: Production SMTP transport binding

**What to build:** The instance-scoped half of the settings boundary (ADR-0022): the real outbound mail transport. The Instance Operator configures SMTP via deployment configuration — out-of-band from the dashboard, part of the trust fabric — and all platform mail (verification, reset, invitation, email-change) flows through it. The in-memory capture binding from ticket 01 remains the test binding, selectable by configuration; callers are untouched (the seam's whole point).

**Blocked by:** 03 (first real mail flows exist to bind).

**Status:** done

- [x] SMTP connection details are provided via deployment configuration only — never editable from the dashboard or Management API
- [x] All outbound platform mail (verification, reset, invitation, email change) is delivered through the configured transport
- [x] The in-memory capture binding remains available and is selected by configuration for tests, with no caller changes
- [x] Misconfiguration (unreachable relay) is diagnosable from startup/health without leaking secrets into logs
- [x] Black-box tests keep running against the capture binding, proving the seam held

## Comments

Implementation notes:

- `SmtpMailTransport` (`backend/src/mail/smtp.transport.ts`) is the production binding of the existing `MAIL_TRANSPORT` seam. It wraps `nodemailer`; `MailService.send` and every caller (sign-up verification, password reset, invitation, email change) are untouched — `mail.module.ts` selects the transport by `MAIL_TRANSPORT_BINDING`, and only the capture binding mounts `/dev/mail`.
- Connection details are deployment configuration, read once at boot by `smtp.config.ts`: `SMTP_HOST`, `SMTP_PORT`, optional `SMTP_USER`/`SMTP_PASSWORD` (both or neither), optional `SMTP_SECURE` (default: port 465), optional `SMTP_REQUIRE_TLS` (default: required when credentials are configured, so a password is never sent over a cleartext session without an explicit opt-out), and `MAIL_FROM` (validated envelope sender). Missing or malformed values fail startup naming the variable, never its value; the Management API's allowlist (`organization_settings`) still refuses any instance-scoped key.
- Diagnosability: boot logs `SMTP relay at host:port is reachable` or `… is unreachable: <reason>`, and `GET /health` answers `{ status: 'ok' | 'degraded', mail: { binding, reachable } }`. The public health payload deliberately carries no endpoint or failure text — the detail stays in the startup log, where the Instance Operator reads it — and every diagnostic is sanitized against the configured user/password before surfacing. An unreachable relay is diagnostic, not fatal: the Instance keeps serving and probes again (5s cache).
- Tests: `e2e/src/smtp-binding.test.ts` (13 tests, HTTP + a local `smtp-server` sink) covers delivery of invitation, sign-up verification (its link still completes), reset, and email-change mail through the configured relay with the configured credentials; health naming the binding; the capture surface being absent under SMTP; the Management API exposing only Organization-scoped settings; a dead relay reported `degraded` with no endpoint/credential in the body or logs; missing `SMTP_HOST`/`SMTP_PASSWORD` failing startup loudly; and the capture binding unchanged. Full suite: 210 tests across 21 files.
- Review round applied: the public `/health` payload was trimmed to `{ binding, reachable }` (an unauthenticated endpoint should not enumerate the relay or its errors); missing credentials are modeled as one `auth` value instead of two nullable strings; status recording is one private helper; the e2e harness exports `freePort` instead of tests re-implementing it; and the email-change flow now gets the same delivery proof as the other three mail kinds.

# 03: Decide the production configuration contract

**Type:** grilling
**Status:** resolved
**Blocked by:** 01

## Question

What must a production Instance validate at startup, and which development fallbacks must it refuse?

Facts: configuration is read ad hoc from `process.env` (`backend/src/config/env.ts`; no `@nestjs/config`); invalid numeric TTL/count values silently fall back to defaults (`config/env.ts:6-19`); with `IDENTIK_SIGNING_JWKS` unset the Instance generates an ephemeral signing key with a warning (`oidc/signing-keys.service.ts:49-53,102-109`); the Administrator session TTL is hardcoded at 12h (`administrators.service.ts:25`); `.env.example` omits the required `MAIL_FROM` (`mail/smtp.config.ts:99`).

Settle: a validated configuration schema; which variables are required when (and what happens on invalid values — fail-fast vs clamped default); what "production mode" means and which fallbacks it refuses (ephemeral signing keys, capture mail binding); which hardcoded operational values become configurable; and how `.env.example` documents the contract. Secrets (`DATABASE_URL`, `SMTP_*`, `IDENTIK_SIGNING_JWKS`) stay deployment-held per ADR-0022 — confirm nothing moves into the dashboard.

## Answer

**Fail-closed by default (Q1).** There is no `NODE_ENV`/`IDENTIK_ENV` mode. The Instance is production-strict unless a single explicit development opt-in is present: `IDENTIK_DEV_MODE=1`. Without it, `IDENTIK_SIGNING_JWKS` is required (no ephemeral keys), `MAIL_TRANSPORT_BINDING=capture` is refused, and the `/dev/mail` surface is never mounted. With it, both dev fallbacks are permitted; tests and local demos set it explicitly.

**Boot-time validation (Q2).** One validated configuration schema loads at startup:

- required: `DATABASE_URL`, `IDENTIK_BASE_URL`, `MAIL_TRANSPORT_BINDING`, `IDENTIK_SIGNING_JWKS` (unless dev mode);
- required when `MAIL_TRANSPORT_BINDING=smtp`: `SMTP_HOST`, `SMTP_PORT`, `MAIL_FROM`, plus `SMTP_USER`/`SMTP_PASSWORD` as a pair;
- `PORT` defaults to 3000 but must be a valid port when set;
- absent optional TTL/throttle knobs keep their documented defaults; present-but-invalid values fail startup with actionable messages — never silently fall back (replacing `parseTtlMs`/`parseCount`, `config/env.ts:6-19`).

**No new knobs (Q3).** The 12h Administrator session TTL, cookie names, mail-reachability cache, and secret constants stay fixed; the existing TTL and throttle variables remain the only tunables.

**Documented contract (Q4).** `.env.example` is corrected and regrouped: `MAIL_FROM` added; required vs optional marked; `IDENTIK_SIGNING_JWKS` marked production-required; `capture` and ephemeral keys marked development-only behind the opt-in; secrets stay deployment-held (ADR-0022). The file remains documentation, not a loader.

**Amendment (later ticket).** "Set the network-edge and browser security posture" adds one deployment-shape tunable, `IDENTIK_TRUST_PROXY` (default off). The "no new knobs" ruling above covered the fixed constants it listed; it does not forbid this proxy-trust setting.



# 09: Unify the error and validation contract

**Type:** grilling
**Status:** open
**Blocked by:** 01, 08

## Question

What error and validation contract must the HTTP surface speak before the frontends are built?

Facts: three response shapes coexist — Nest's default `{statusCode, message, error}`; custom bodies `{error, message}` and `{error, code, message}` (`organization-settings.service.ts`, `identities.service.ts`); and OAuth protocol `{error, error_description}`. The global pipe is `whitelist: true, transform: true` only (`main.ts:10`), so unknown properties are silently dropped rather than rejected. Several bodies bypass DTO validation entirely: token, revoke, introspect, userinfo, `confirm` bodies, and settings (`token.controller.ts:27`, `token-management.controller.ts`, `userinfo.controller.ts:28`, `identities.controller.ts:136`, `applications.controller.ts:161`, `organization-settings.service.ts:250-271`). There is no OpenAPI document.

Settle: one documented envelope for non-OAuth surfaces with stable codes and validation detail; how OAuth protocol errors remain protocol-shaped; whether unknown properties are rejected; DTO coverage for currently unvalidated bodies; and where the contract is documented. Input: ticket 08's final surface list.

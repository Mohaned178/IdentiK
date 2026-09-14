# 13: Set the observability floor

**Type:** grilling
**Status:** open
**Blocked by:** 01, 02

## Question

What must the Instance emit for an operator to run it in production?

Facts: Nest's default console logger is the only output; a handful of `Logger` calls exist (`smtp.transport.ts`, `signing-keys.service.ts`, `end-users.controller.ts`); the Bootstrap token reaches stdout via `console.log` (`bootstrap.service.ts:86-90`). There is no request logging, no request IDs, no structured/JSON format, no log-level control, no metrics, and no tracing. The audit surface is admin-only and is not an operational log stream.

Settle: the logging contract (structure, levels, request correlation, redaction of secrets/tokens/emails); whether metrics and tracing are required this release or ruled out; how operational logs relate to the audit surface; and what the container's stdout/stderr expectations are. Depends on topology (02) for replica aggregation.

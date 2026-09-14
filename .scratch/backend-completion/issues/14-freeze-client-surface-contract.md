# 14: Freeze the client-surface contract

**Type:** grilling
**Status:** open
**Blocked by:** 01

## Question

Under the completion bar (the deployable-Instance floor), how frozen must the Management API and the other first-party client surfaces be when backend completion is declared? The dashboard does not exist (the UI workspace was removed), so the user stories are the only available contract, and frontend work starts after Dockerization.

Settle:

- **(a) Stories are the contract.** The surface is complete when the administrator stories are satisfiable, and additive, non-breaking changes discovered while building the frontend do not reopen the bar.
- **(b) Frozen exactly.** UI-driven additions require a new, explicitly scoped backend increment.
- **(c) Open.** Frontend work may freely drive non-additive API change; backend completion does not freeze the surface.

State what "reopens the bar" means and which surfaces the policy covers (Management API, Account Center, hosted pages, OIDC).

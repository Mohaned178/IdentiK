# 08: Close the Management API gaps the dashboard needs

**Type:** grilling
**Status:** open
**Blocked by:** 01, 14

## Question

Which Management API gaps must close before the dashboard can be built without backend rework?

Facts: the API surface exists for Applications (register/list/detail/disable/enable/delete/secrets/redirect URIs/scopes/enrollments/suspension), Identities (list/detail/suspend/unsuspend/revoke-all/force-reset/anonymize), audit reads, Organization settings, and Bootstrap. The Administrator lifecycle stops at invite/accept: there is no list, role change, or removal for Administrators (`administrators.controller.ts` has only `sign-in`, `sign-out`, `session`, `invitations`, `invitations/accept`), no invitation listing or revocation, and no Application update (e.g., rename). No pagination or filtering convention is stated for list endpoints generally.

Settle, judged against user stories 3–6, 9–18, 34–47, 59, 62–64: which missing capabilities are required backend work; which are UI conveniences deferred to frontend work; list pagination/ordering conventions; and — per "Freeze the client-surface contract" — how frozen the surface must be, given no dashboard design exists (the UI workspace was removed) and the stories are the only contract.

Deliverable: a gap list triaged required / deferred.

# IdentiK Postman files

Drive the local API by hand: a collection covering all 63 implemented
operations (plus OAuth grant variants), and an environment for local
development.

Files:

- `IdentiK.postman_collection.json` — 12 folders in golden-path order:
  Health → Bootstrap / Setup → Administrators & Invitations →
  Organization → Applications → Identities (Management) →
  End Users (Sign-up, Verify, Reset) → Account Center →
  OIDC Discovery & JWKS → OIDC Authorization Code Flow → Audit →
  Development. Every request documents what the endpoint does, when it is
  used, its authentication, parameters, body, success shape, and the
  failures worth knowing.
- `IdentiK.local.postman_environment.json` — `baseUrl` plus IDs, tokens,
  and throwaway dev credentials. Secrets use the `secret` type; real
  values are captured by scripts at runtime, never stored here.

## Import

1. Postman → Import → drop in both files (or File → Import).
2. Select the **IdentiK Local** environment (top-right).
3. Start the backend in dev mode (`IDENTIK_DEV_MODE=1`,
   `MAIL_TRANSPORT_BINDING=capture`, migrated database).
4. Copy the one-time setup token from the server log into `setupToken`.
5. Run the folders top to bottom. Test scripts capture `organizationId`,
   `applicationId`, `clientId`, `clientSecret`, `identityId`,
   `authorizationCode`, tokens, and mailbox tokens automatically.

## Notes that save time

- Administrator routes use the `identik_admin_session` cookie set by
  **Sign in (Administrator)**; Account Center uses the `identik_sso_session`
  cookie set by **Authorize sign-in**. Postman's cookie jar sends both
  automatically — no manual headers.
- The two authorize requests answer 302 with `?code=`. Turn off automatic
  redirect following for them (request Settings tab) so the test script
  can read the `Location` header into `authorizationCode`.
- The SPA exchange mints its own PKCE verifier/challenge per run via a
  pre-request script (CryptoJS is built into Postman).
- Sign-up and forgot-password answers are uniform by design; outcomes
  travel to the mailbox. In dev, **List captured mail** finds the newest
  token-bearing mail to `endUserEmail` and captures its `token=` link
  parameter (duplicate sign-ups mail a tokenless notice, which the script
  skips).
- The collection mirrors the implementation; anything trough-shaped that
  changes in `backend/src` should be reflected here. Cross-check against
  the dev Swagger JSON at `/api/docs-json`.

# 04: Gate startup on migration state and ship the pinned CLI

**What to build:** The server never migrates; deploying the schema stays an explicit one-off command run from the release artifact. At startup the Instance compares the migrations shipped in its artifact with the database's migration bookkeeping: a database behind this release refuses to serve with the migration command named, a database ahead of the app starts, and an artifact missing its migrations directory fails loudly. The migration CLI becomes a production dependency exact-pinned to the runtime client, with the tarball's pinned `npx` fallback documented.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] Against a database provisioned to an earlier migration state, startup refuses with the migration command in the message.
- [x] Against a database carrying an applied migration unknown to the artifact, startup succeeds.
- [x] An artifact without its migrations directory fails startup loudly.
- [x] The CLI ships as a production dependency exact-pinned to the runtime client's version; the tarball's pinned `npx` fallback stays documented.
- [x] No boot-time migration exists; concurrent migration attempts rely on the migration tool's advisory lock.
- [x] Provisioning-based e2e scenarios cover the refusals; the full suite stays green.

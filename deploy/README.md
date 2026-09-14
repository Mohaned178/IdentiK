# IdentiK deployment and operations runbook

This is the execution procedure for the Instance Operator. It assumes the
supported deployment envelope in [`docs/operator-guide.md`](../docs/operator-guide.md)
and the decisions it rests on. Everything here runs on the VPS over SSH, as
root, from the pinned checkout at `/opt/identik`.

The deploy unit is the git checkout at the release tag: `docker-compose.yml`,
`Caddyfile`, `.env`, and these scripts move together, and the image tag in
`.env` must match the git tag. The deploy script refuses anything else.

- [1. First install](#1-first-install)
- [2. Normal deploy](#2-normal-deploy)
- [3. Rollback](#3-rollback)
- [4. Migration policy](#4-migration-policy)
- [5. Applying configuration changes](#5-applying-configuration-changes)
- [6. First boot and bootstrap](#6-first-boot-and-bootstrap)
- [7. Operator curl runbook](#7-operator-curl-runbook)
- [8. Backups](#8-backups)
- [9. Restore](#9-restore)
- [10. Observability floor](#10-observability-floor)
- [11. Failure and recovery matrix](#11-failure-and-recovery-matrix)
- [12. Drills](#12-drills)
- [13. PostgreSQL upgrades](#13-postgresql-upgrades)
- [14. Host baseline checklist](#14-host-baseline-checklist)

## 1. First install

One time, on the provisioned host:

```sh
# 1. The host baseline is at the end of this document; apply it first.

# 2. The checkout, pinned at a released tag.
install -d -o root -g root -m 0755 /opt/identik
git clone https://github.com/mohaned178/identik.git /opt/identik
cd /opt/identik
git checkout v0.1.0

# 3. The secrets file: root-owned, 0600, gitignored (verify: git check-ignore deploy/.env).
cd deploy
cp .env.example .env
chown root:root .env && chmod 0600 .env
# Fill it in: POSTGRES_PASSWORD (openssl rand -hex 24), IDENTIK_HOSTNAME,
# IDENTIK_IMAGE_TAG (the released tag), the SMTP relay values, and
# IDENTIK_SIGNING_JWKS minted by `docker run --rm <image> keygen`.
chmod 0755 deploy.sh backup.sh

# 4. Registry access, if the image package is private.
echo "$GHCR_READ_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin

# 5. Boot the database and proxy, then deploy the app through the tested script.
cd /opt/identik/deploy
docker compose up -d postgres proxy
./deploy.sh v0.1.0

# 6. Confirm the first-boot state.
docker compose ps
curl -fsS "https://<hostname>/api/setup/status"   # completed:false, available:true
```

The first boot prints a one-time setup token — capture it immediately, see
[section 6](#6-first-boot-and-bootstrap). Then install backups
([section 8](#8-backups)) and the external probe
([section 10](#10-observability-floor)).

## 2. Normal deploy

Every release is a new immutable tag; deploys pin it. A bad release never rides
a movable tag.

```sh
cd /opt/identik
git fetch --tags
git checkout v0.1.1

# Point the deploy unit at the same tag (the script refuses a mismatch):
sed -i 's|^IDENTIK_IMAGE_TAG=.*|IDENTIK_IMAGE_TAG=ghcr.io/mohaned178/identik:v0.1.1|' deploy/.env

./deploy/deploy.sh v0.1.1
```

The script, in order:

1. refuses a dirty checkout, a checkout not exactly at `v0.1.1`, or a `.env`
   image that does not end in `:v0.1.1`;
2. records the previous running image (for rollback) and prints it;
3. `docker compose pull`;
4. `docker compose run --rm app migrate` — migrations are always an explicit
   one-off, never at app start;
5. `docker compose up -d --force-recreate app`;
6. polls `https://<hostname>/health/ready` until HTTP 200 and
   `"database":{"ok":true}` (mail may be `degraded`; that never fails a
   deploy), for up to 180 seconds. The poll skips certificate validation;
   certificate expiry is the external monitor's job
   ([section 10](#10-observability-floor)).

Success prints `==> deployed <image>`. Any failure prints the rollback
commands and exits non-zero.

Tunables, for a slow host: `DEPLOY_READY_TIMEOUT_SECONDS`,
`DEPLOY_READY_POLL_SECONDS`.

**Proxy changes travel with releases.** Deploying a tag whose `Caddyfile`
changed also needs the proxy recreated:

```sh
cd /opt/identik/deploy && docker compose up -d --force-recreate proxy
```

## 3. Rollback

Use it when the readiness verification failed or when the new release behaves
badly. The deploy script prints exactly these commands on failure; the previous
image was running seconds ago, so it is still cached locally.

```sh
cd /opt/identik
git checkout <previous-tag>
sed -i 's|^IDENTIK_IMAGE_TAG=.*|IDENTIK_IMAGE_TAG=<previous-image>|' deploy/.env
cd deploy
docker compose up -d --force-recreate app
curl -fsSk --resolve "<hostname>:443:127.0.0.1" "https://<hostname>/health/ready"
```

Rollback never touches the database. That is safe because migrations are
additive-only and the old release accepts a database that is ahead of it (the
startup gate tolerates applied migrations the release has never heard of). A
rollback does not re-run `migrate`.

If the failed deploy changed `.env` values, restore them too — the last backup
contains a copy of `.env` as it was when it ran ([section 8](#8-backups)).

## 4. Migration policy

- **Additive-only.** A release never drops or renames a column or table in the
  same release as the code that stops using it. The removal ships later, once
  nothing running reads it.
- **A failed migration is fixed forward.** The database is never rolled back
  (each Prisma migration runs transactionally on PostgreSQL). Write a new
  migration, release it, deploy again.
- **Migrate before the app.** The deploy script enforces the floor's order; the
  app's startup gate refuses to serve a database that is behind the release.

## 5. Applying configuration changes

Configuration loads once at boot, so every change applies by recreating the
service that reads it:

| Change | Command |
| --- | --- |
| `.env` secrets/settings (SMTP, signing keys, trust proxy) | `docker compose up -d --force-recreate app` |
| Signing-key rotation | prepend the new key to `IDENTIK_SIGNING_JWKS`, recreate, wait out the longest token TTL (refresh default: 30 days), drop the old key, recreate — see `deploy/.env.example` |
| `Caddyfile` | `docker compose up -d --force-recreate proxy` |
| `docker-compose.yml` | `docker compose up -d` (recreates what changed) |
| PostgreSQL image pin | [section 13](#13-postgresql-upgrades) |

Never set `IDENTIK_DEV_MODE` or `IDENTIK_TEST_DATABASE_URL` on a live host.

## 6. First boot and bootstrap

The first boot prints a one-time setup token to the app log:

```sh
cd /opt/identik/deploy
docker compose logs app | grep 'setup token'
```

**Captured before anything recreates the app.** A restart before the ceremony
completes forces a reinstall, and the token cannot be revealed again.

There is no `/setup` page — the ceremony is the API:

```sh
curl -fsS "https://<hostname>/api/setup/status"
# {"completed":false,"available":true}

curl -fsS -X POST "https://<hostname>/api/setup?token=<token>" \
  -H 'Content-Type: application/json' \
  -d '{"organizationName":"Acme","email":"owner@example.com","password":"<strong-secret>","name":"Owner Name"}'
# 201 with the Organization and first Owner
```

Afterwards `GET /api/setup/status` reports `"completed":true` and the audit
surface shows the ceremony.

## 7. Operator curl runbook

Administrator authentication is cookie-based; keep a cookie jar. Set
`HOSTNAME` to the Instance hostname first. If the VPS cannot reach its own
public name, add `--resolve "$HOSTNAME:443:127.0.0.1"` to every call.

```sh
HOSTNAME=id.example.com
JAR=/root/identik-admin.cookies

# Sign in (Owner created at bootstrap, or an invited Administrator).
curl -fsS -c "$JAR" -X POST "https://$HOSTNAME/api/administrators/sign-in" \
  -H 'Content-Type: application/json' \
  -d '{"email":"owner@example.com","password":"<secret>"}'

# Who am I; sign out.
curl -fsS -b "$JAR" "https://$HOSTNAME/api/administrators/session"
curl -fsS -b "$JAR" -X POST "https://$HOSTNAME/api/administrators/sign-out"

# Invite an Administrator (Owner-only); the invitee accepts with their own password.
curl -fsS -b "$JAR" -X POST "https://$HOSTNAME/api/administrators/invitations" \
  -H 'Content-Type: application/json' -d '{"email":"second@example.com","role":"member"}'
curl -fsS "https://$HOSTNAME/api/administrators/invitations?token=<invitation-token>"
curl -fsS -X POST "https://$HOSTNAME/api/administrators/invitations/accept" \
  -H 'Content-Type: application/json' \
  -d '{"token":"<invitation-token>","name":"Second Admin","password":"<secret>"}'

# Register a Web Application (Owner-only; the Client Secret is shown once).
curl -fsS -b "$JAR" -X POST "https://$HOSTNAME/api/applications" \
  -H 'Content-Type: application/json' -d '{"name":"My App","type":"web"}'
# → {"application":{...,"id":"<app-id>"},"clientSecret":"<shown once>"}

# Follow-ups (all Owner-only except listing).
curl -fsS -b "$JAR" "https://$HOSTNAME/api/applications"
curl -fsS -b "$JAR" "https://$HOSTNAME/api/applications/<app-id>"
curl -fsS -b "$JAR" -X POST "https://$HOSTNAME/api/applications/<app-id>/redirect-uris" \
  -H 'Content-Type: application/json' -d '{"uri":"https://app.example.com/callback"}'
curl -fsS -b "$JAR" -X PUT "https://$HOSTNAME/api/applications/<app-id>/scopes" \
  -H 'Content-Type: application/json' -d '{"scopes":["openid","email","profile"]}'
curl -fsS -b "$JAR" -X POST "https://$HOSTNAME/api/applications/<app-id>/secrets" \
  -H 'Content-Type: application/json' -d '{"label":"rotation-2026-09"}'

# Visibility.
curl -fsS -b "$JAR" "https://$HOSTNAME/api/audit"
```

Known gaps at this phase (non-blocking, tracked elsewhere): no Administrator
password rotation, no invitation listing/revocation, no Administrator
role/removal API.

## 8. Backups

Backups run nightly from root cron and cover the database and the entire trust
fabric: each run stores `pg_dump -Fc` plus a copy of `deploy/.env`, with
SHA-256 checksums, keeps the newest 7 pairs on the host, and copies every run
off-host. RPO ≤ 24 hours is the accepted bar for dogfooding; PITR is deferred.

Accepted at install time:

```sh
cd /opt/identik/deploy
cp backup.conf.example backup.conf
chown root:root backup.conf && chmod 0600 backup.conf
# Edit it: configure the off-host command (and retention), and encryption if
# the destination is not a private machine you control.
./backup.sh          # first run, by hand; must end with "backup complete"

# Install the nightly job (03:17 UTC, root).
cat >/etc/cron.d/identik-backup <<'EOF'
17 3 * * * root /opt/identik/deploy/backup.sh >> /var/log/identik-backup.log 2>&1
EOF
chmod 0644 /etc/cron.d/identik-backup
```

The script fails loudly (non-zero exit) on any step: dump, checksum, `.env`
copy, off-host copy, or off-host prune. Check freshness and integrity with:

```sh
ls -lt /var/backups/identik | head
cd /var/backups/identik && sha256sum -c identik-<stamp>.SHA256SUMS
tail -20 /var/log/identik-backup.log
```

A backup that is only on this host is not a backup: the off-host copy is
required, and the last `.env` copy is what makes signing-key loss survivable.

## 9. Restore

### Disaster recovery (fresh volume, in place)

Use this when the database is lost or corrupted. It destroys the current data
volume — take a dump first if the database is still readable.

```sh
cd /opt/identik/deploy
ls -lt /var/backups/identik | head                       # pick the newest dump
docker compose stop app
docker compose down
docker volume rm identik_pgdata                          # fresh cluster next start

# If the host lost deploy/.env, restore it before any compose command:
# install -o root -g root -m 0600 /var/backups/identik/identik-<stamp>.env .env

docker compose up -d postgres
until docker inspect --format '{{.State.Health.Status}}' identik-postgres-1 2>/dev/null | grep -q healthy; do sleep 2; done

docker compose exec -T postgres pg_restore -U postgres -d identik --no-owner \
  < /var/backups/identik/identik-<stamp>.dump

docker compose up -d app
```

Verify, then re-enable the probe:

```sh
curl -fsSk --resolve "$(sed -n 's/^IDENTIK_HOSTNAME=//p' .env):443:127.0.0.1" \
  "https://$(sed -n 's/^IDENTIK_HOSTNAME=//p' .env)/health/ready"   # database.ok true
curl -fsS "https://$(sed -n 's/^IDENTIK_HOSTNAME=//p' .env)/api/setup/status"   # completed true
# Sign in with the cookie jar (section 7); the audit surface has pre-restore rows.
```

### Drill variant (fresh volume, live stack untouched)

[Drill 12.2](#12-drills) restores into a throwaway volume and throws it away.
It never touches `identik_pgdata`.

## 10. Observability floor

Metrics, tracing, and log aggregation are deferred. The floor is:

- **External uptime probe** on `https://<hostname>/health/ready`, 5-minute
  interval, alert after 2 consecutive failures to the operator's email. It must
  treat non-200 and a body without `"database":{"ok":true}` as down. Point
  liveness-only probes at `/health/live`.
- **TLS-expiry monitoring** on the same hostname (most probes include an SSL
  expiry check). Renewal is automatic; the alert exists for when DNS, port 80,
  or rate limits break it.
- **Test the alert path once at setup** (send a test alert) — an untested
  probe is not a monitor.
- **Container logs**: stdout/stderr with json-file rotation caps of 10 MB × 3
  per service, set in `docker-compose.yml`.

How to check the Instance:

```sh
cd /opt/identik/deploy
docker compose ps                        # all services Up; app (healthy); proxy ports 80/443
docker compose logs --since 30m app      # boot, migration-gate, SMTP, 5xx errors
curl -fsSk https://<hostname>/health/live
curl -fsSk https://<hostname>/health/ready
ls -lt /var/backups/identik | head       # backup freshness
tail -5 /var/log/identik-backup.log      # backup failures
df -h                                    # disk pressure
docker system df                         # image/volume growth
```

## 11. Failure and recovery matrix

"Downtime" is the expected interruption from detection to serving again.

| Scenario | Detection | Recovery | Expected downtime | Drilled |
| --- | --- | --- | --- | --- |
| VPS reboot | Probe alert; SSH returns | `restart: unless-stopped` brings the stack back automatically; verify readiness and probe | 1–3 min | 12.1 |
| Process crash | Probe alert; `docker compose ps` shows restarts | Restart policy relaunches it; if it crash-loops, read `logs app` and fix forward with a new tag | < 1 min | no |
| Bad deploy | Deploy script readiness verification fails; probe alert | Rollback to the previous tag ([section 3](#3-rollback)); database untouched | ~1 min | 12.3 |
| Database loss or corruption | Readiness 503; logs show DB errors | Restore ([section 9](#9-restore)); accept RPO ≤ 24 h | 15–60 min | 12.2 |
| Disk full | Writes fail; backup exits non-zero; `df -h` | Free space (`docker image prune`, `docker builder prune`, old dumps, `journalctl --vacuum-size=200M`); grow the disk if recurring | degraded until freed | no |
| Signing-key loss | All tokens/sessions invalid after a restart; no warning otherwise | Restore `deploy/.env` from the latest backup; the `ephemeral key` warning in logs means the real keys are missing. No backup means break-glass `keygen` + recreate — every outstanding Session and token dies | none / full re-auth | no |
| Relay outage | Readiness `degraded`; verification/reset/invitation mail fails | Wait for the provider; the Instance keeps serving. Switch relays by editing `.env` and recreating the app | email flows only | no |
| Certificate not renewing | TLS-expiry alert | Check Caddy logs, DNS for the hostname, and that port 80 is reachable; then `docker compose up -d --force-recreate proxy` | none until expiry | no |

## 12. Drills

These three are executed once before go-live (Milestone 6) and their results
recorded in the acceptance checklist. The rest of the matrix is prose until the
Instance has real users.

**12.1 Reboot.** `reboot` the VPS; record the time. Pass: the stack returns
without intervention, `/health/ready` is 200 with `database.ok=true`, and the
external probe turns green. Proves `restart: unless-stopped` and unattended
recovery.

**12.2 Restore.** Restore into a throwaway volume; never touch
`identik_pgdata`. Pass: readiness 200 with `database.ok=true`;
`GET /api/setup/status` reports `completed=true`; Administrator sign-in returns
200 with a session cookie; `select count(*) from audit_events` returns the
pre-backup count.

```sh
cd /opt/identik/deploy
docker volume create identik_pgdata_drill
docker run -d --name identik-postgres-drill --network identik_internal \
  -e POSTGRES_PASSWORD="$(sed -n 's/^POSTGRES_PASSWORD=//p' .env)" -e POSTGRES_DB=identik \
  -v identik_pgdata_drill:/var/lib/postgresql postgres:18.6
until docker exec identik-postgres-drill pg_isready -U postgres >/dev/null 2>&1; do sleep 2; done

docker exec -i identik-postgres-drill pg_restore -U postgres -d identik --no-owner \
  < /var/backups/identik/identik-<stamp>.dump

docker run -d --name identik-app-drill --network identik_internal -p 127.0.0.1:13000:3000 \
  -e DATABASE_URL="postgresql://postgres:$(sed -n 's/^POSTGRES_PASSWORD=//p' .env)@identik-postgres-drill:5432/identik" \
  -e IDENTIK_BASE_URL="https://$(sed -n 's/^IDENTIK_HOSTNAME=//p' .env)" \
  -e IDENTIK_TRUST_PROXY="$(sed -n 's/^IDENTIK_TRUST_PROXY=//p' .env)" \
  -e IDENTIK_SIGNING_JWKS="$(sed -n 's/^IDENTIK_SIGNING_JWKS=//p' .env)" \
  -e MAIL_TRANSPORT_BINDING=smtp \
  -e SMTP_HOST="$(sed -n 's/^SMTP_HOST=//p' .env)" \
  -e SMTP_PORT="$(sed -n 's/^SMTP_PORT=//p' .env)" \
  -e "MAIL_FROM=$(sed -n 's/^MAIL_FROM=//p' .env)" \
  "$(sed -n 's/^IDENTIK_IMAGE_TAG=//p' .env)" server

curl -fsS http://127.0.0.1:13000/health/ready
curl -fsS http://127.0.0.1:13000/api/setup/status

# Clean up.
docker rm -f identik-app-drill identik-postgres-drill
docker volume rm identik_pgdata_drill
```

**12.3 Rollback.** Re-apply the previous tag as in
[section 3](#3-rollback), verify readiness, then return to the current tag.
Pass: readiness 200 with `database.ok=true` under the previous tag, and again
under the restored current tag. Proves the additive-migration promise keeps
tag-level rollback safe.

## 13. PostgreSQL upgrades

**Minor (18.x → 18.y).** Backup first, then let the release carry the new pin:

```sh
/opt/identik/deploy/backup.sh                      # confirm it landed off-host
cd /opt/identik && git fetch --tags && git checkout <new-tag>
sed -i 's|^IDENTIK_IMAGE_TAG=.*|IDENTIK_IMAGE_TAG=ghcr.io/mohaned178/identik:<new-tag>|' deploy/.env
grep 'image: postgres' deploy/docker-compose.yml   # confirm the new 18.y pin
cd deploy && docker compose pull postgres && docker compose up -d postgres
docker compose up -d --force-recreate app
curl -fsSk --resolve "<hostname>:443:127.0.0.1" "https://<hostname>/health/ready"
```

The same-major data directory is reused; brief database downtime is expected
while the container restarts.

**Major (e.g. 18 → 19).** Not an in-place upgrade. Take a dump, start the new
major on a fresh volume, `pg_restore` into it, verify, then retire the old
volume. Treat it as a planned restore with the downtime of
[section 9](#9-restore).

## 14. Host baseline checklist

The host is part of the trust fabric. Apply all of it before the first deploy;
anything beyond this list (IDS, auditd, CIS hardening) is deferred.

- [ ] **Key-only SSH**: `PasswordAuthentication no`, `PermitRootLogin prohibit-password` in `/etc/ssh/sshd_config.d/`, then `sshd -t && systemctl reload ssh`.
- [ ] **Firewall, only 22/80/443**:
  ```sh
  ufw default deny incoming && ufw default allow outgoing
  ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp
  ufw enable
  ```
- [ ] **Unattended security updates** with a deliberate reboot policy:
  `apt install -y unattended-upgrades`; do not enable automatic reboots —
  watch `/var/run/reboot-required` and schedule reboots (then run drill 12.1
  again after the first one).
- [ ] **Docker from the official repository** plus the compose v2 plugin
  (`docker compose version`).
- [ ] **Deploy directory ownership**: `/opt/identik` root-owned 0755;
  `deploy/.env` root-owned 0600; `/var/backups/identik` root-owned 0700.

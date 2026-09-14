#!/usr/bin/env bash
#
# Nightly backup: pg_dump + deploy/.env, kept on-host and copied off-host.
# Configure deploy/backup.conf first; the runbook is deploy/README.md.
#
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PG_USER="postgres"
PG_DB="identik"

fail() { echo "BACKUP FAILED: $*" >&2; exit 1; }

[ -f "$DEPLOY_DIR/.env" ] || fail "deploy/.env is missing"
[ -f "$DEPLOY_DIR/docker-compose.yml" ] || fail "deploy/docker-compose.yml is missing"

# shellcheck source=/dev/null
[ -f "$DEPLOY_DIR/backup.conf" ] && . "$DEPLOY_DIR/backup.conf"
: "${IDENTIK_BACKUP_DIR:=/var/backups/identik}"
: "${IDENTIK_BACKUP_LOCAL_KEEP:=7}"
: "${IDENTIK_BACKUP_OFFSITE_CMD:=}"
: "${IDENTIK_BACKUP_OFFSITE_PRUNE_CMD:=}"
: "${IDENTIK_BACKUP_AGE_RECIPIENT:=}"

[ -n "$IDENTIK_BACKUP_OFFSITE_CMD" ] || fail "IDENTIK_BACKUP_OFFSITE_CMD is not configured (see deploy/backup.conf.example)"
case "$IDENTIK_BACKUP_LOCAL_KEEP" in
  ''|*[!0-9]*) fail "IDENTIK_BACKUP_LOCAL_KEEP must be a positive integer" ;;
esac
[ "$IDENTIK_BACKUP_LOCAL_KEEP" -ge 1 ] || fail "IDENTIK_BACKUP_LOCAL_KEEP must be a positive integer"
if [ -n "$IDENTIK_BACKUP_AGE_RECIPIENT" ]; then
  command -v age >/dev/null 2>&1 || fail "IDENTIK_BACKUP_AGE_RECIPIENT is set but age is not installed"
fi

umask 077
mkdir -p "$IDENTIK_BACKUP_DIR"
chmod 0700 "$IDENTIK_BACKUP_DIR"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
base="identik-${stamp}"
dump="$IDENTIK_BACKUP_DIR/${base}.dump"
env_copy="$IDENTIK_BACKUP_DIR/${base}.env"
sums="$IDENTIK_BACKUP_DIR/${base}.SHA256SUMS"
stage="$IDENTIK_BACKUP_DIR/offsite-${base}"

echo "==> dumping ${PG_DB} to ${dump}"
(cd "$DEPLOY_DIR" && docker compose exec -T postgres pg_dump -Fc -U "$PG_USER" -d "$PG_DB") > "$dump" \
  || fail "pg_dump failed"
[ -s "$dump" ] || fail "pg_dump produced an empty file"
echo "    $(wc -c < "$dump") bytes"

echo "==> copying deploy/.env"
install -m 0600 "$DEPLOY_DIR/.env" "$env_copy" || fail "could not copy deploy/.env"
(cd "$IDENTIK_BACKUP_DIR" && sha256sum "${base}.dump" "${base}.env") > "$sums" || fail "checksumming failed"

echo "==> staging the off-host copy"
mkdir -m 0700 "$stage"
if [ -n "$IDENTIK_BACKUP_AGE_RECIPIENT" ]; then
  age -r "$IDENTIK_BACKUP_AGE_RECIPIENT" -o "$stage/${base}.dump.age" "$dump" || fail "age encryption of the dump failed"
  age -r "$IDENTIK_BACKUP_AGE_RECIPIENT" -o "$stage/${base}.env.age" "$env_copy" || fail "age encryption of deploy/.env failed"
  (cd "$stage" && sha256sum ./*.age) > "$stage/${base}.SHA256SUMS" || fail "checksumming the encrypted copy failed"
else
  cp -p "$dump" "$env_copy" "$sums" "$stage/" || fail "staging the off-host copy failed"
fi

echo "==> copying off-host"
BACKUP_STAGING="$stage" BACKUP_BASE="$base" sh -c "$IDENTIK_BACKUP_OFFSITE_CMD" identik-backup "$stage" \
  || fail "off-host copy failed"

echo "==> pruning off-host copies"
if [ -n "$IDENTIK_BACKUP_OFFSITE_PRUNE_CMD" ]; then
  sh -c "$IDENTIK_BACKUP_OFFSITE_PRUNE_CMD" || fail "off-host prune failed"
else
  echo "    no IDENTIK_BACKUP_OFFSITE_PRUNE_CMD configured; off-host retention is not enforced"
fi

rm -rf "$stage"

echo "==> pruning local dumps beyond ${IDENTIK_BACKUP_LOCAL_KEEP}"
find "$IDENTIK_BACKUP_DIR" -maxdepth 1 -type f -name 'identik-*.dump' -printf '%T@ %p\n' \
  | sort -rn \
  | tail -n "+$((IDENTIK_BACKUP_LOCAL_KEEP + 1))" \
  | cut -d' ' -f2- \
  | while IFS= read -r old; do
      rm -f "$old" "${old%.dump}.env" "${old%.dump}.SHA256SUMS"
    done
find "$IDENTIK_BACKUP_DIR" -maxdepth 1 -type d -name 'offsite-*' -mtime +1 -exec rm -rf {} +

echo "==> backup complete: ${base}"

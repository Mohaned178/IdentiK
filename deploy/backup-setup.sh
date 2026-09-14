#!/usr/bin/env bash
#
# Configure the off-host backup destination (Milestone 5.7 + 5.4).
# Scaffolds deploy/backup.conf from the example, generating an age identity if
# the destination is not a private machine you control, then runs the backup
# once by hand and installs the nightly root cron job.
#
#   bash deploy/backup-setup.sh
#
# Before running: the off-host destination must exist (Storage Box, second
# machine, or object storage) with write access from this host. The offsite
# command receives the staging directory as "\$1".
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF_FILE="$DEPLOY_DIR/backup.conf"
EXAMPLE_FILE="$DEPLOY_DIR/backup.conf.example"
ENV_FILE="$DEPLOY_DIR/.env"

[ -f "$ENV_FILE" ] || { echo "deploy/.env missing — run setup-env.sh first" >&2; exit 1; }
[ -f "$EXAMPLE_FILE" ] || { echo "missing $EXAMPLE_FILE" >&2; exit 1; }

prompt() {
  local label="$1" default="${2:-}" value=""
  if [ -n "$default" ]; then
    read -r -p "    ${label} [${default}]: " value
    printf '%s\n' "${value:-$default}"
  else
    read -r -p "    ${label}: " value
    printf '%s\n' "$value"
  fi
}

echo "==> writing deploy/backup.conf"
install -m 0600 -o root -g root "$EXAMPLE_FILE" "$CONF_FILE"

offsite_cmd="${IDENTIK_BACKUP_OFFSITE_CMD:-}"
while [ -z "$offsite_cmd" ]; do
  offsite_cmd="$(prompt 'Offsite command, staging dir as $1 (e.g. rsync -az --partial -e ssh "$1/" user@host:/path/')"
done

prune_cmd="${IDENTIK_BACKUP_OFFSITE_PRUNE_CMD:-}"
if [ -z "$prune_cmd" ]; then
  read -r -p "    Offsite retention command (blank to skip): " prune_cmd || true
fi

use_age="${IDENTIK_BACKUP_AGE_RECIPIENT:-$(prompt 'Encrypt off-host copies with age? (y/N)' n)}"
case "$use_age" in
  y|Y|yes|YES)
    keyfile="/root/identik-backup.agekey"
    if command -v age-keygen >/dev/null 2>&1 && [ ! -f "$keyfile" ]; then
      printf '%s\n' "y" | age-keygen -o "$keyfile" >/dev/null 2>&1 || true
      chmod 0600 "$keyfile"
    fi
    if [ -f "$keyfile" ]; then
      recipient="$(age-keygen -y "$keyfile")"
      echo "    age recipient: ${recipient}"
      echo "    KEYFILE KEEP  : ${keyfile}  (keep this safe — it decrypts your backups)"
      echo "    WARNING: if you lose the keyfile, the off-host copy is unrecoverable."
    else
      recipient="$(prompt 'age recipient (age1... or blank)')"
    fi
    ;;
  *) recipient="${IDENTIK_BACKUP_AGE_RECIPIENT:-}" ;;
esac

# Rewrite the values into the config file line-by-line (avoids sed escaping).
tmp="$CONF_FILE.tmp"
: > "$tmp"
while IFS= read -r line; do
  case "$line" in
    IDENTIK_BACKUP_OFFSITE_CMD=*)         printf 'IDENTIK_BACKUP_OFFSITE_CMD=%s\n' "$offsite_cmd" ;;
    IDENTIK_BACKUP_OFFSITE_PRUNE_CMD=*)   printf 'IDENTIK_BACKUP_OFFSITE_PRUNE_CMD=%s\n' "$prune_cmd" ;;
    '#'IDENTIK_BACKUP_AGE_RECIPIENT=*)    [ -n "$recipient" ] && printf 'IDENTIK_BACKUP_AGE_RECIPIENT=%s\n' "$recipient" || printf '%s\n' "$line" ;;
    *)                                    printf '%s\n' "$line" ;;
  esac
done < "$EXAMPLE_FILE" > "$tmp"
mv "$tmp" "$CONF_FILE"
chown root:root "$CONF_FILE"
chmod 0600 "$CONF_FILE"

echo
echo "==> first backup run by hand"
"$DEPLOY_DIR/backup.sh"

echo
echo "==> installing the nightly cron (03:17 UTC)"
cat >/etc/cron.d/identik-backup <<EOF
17 3 * * * root $DEPLOY_DIR/backup.sh >> /var/log/identik-backup.log 2>&1
EOF
chmod 0644 /etc/cron.d/identik-backup
echo "    /etc/cron.d/identik-backup installed"

cat <<EOF

==> backup configured. Check freshness with:
      ls -lt /var/backups/identik | head
      cd /var/backups/identik && sha256sum -c identik-<stamp>.SHA256SUMS
      tail -20 /var/log/identik-backup.log
EOF
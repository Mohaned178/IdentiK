#!/usr/bin/env bash
#
# Generate deploy/.env for a fresh host: fills the required host secret set,
# generating the PostgreSQL password and signing JWKS automatically, and
# prompting for the operator-only values (hostname, SMTP relay).
#
#   bash deploy/setup-env.sh [IMAGE_TAG]
#
# IMAGE_TAG defaults to ghcr.io/mohaned178/identik:v0.1.0 and is pre-pulled if
# needed so `keygen` runs from the real artifact. The file it writes is
# root-owned 0600 and gitignored. Re-run any time to regenerate; it never
# touches the running stack (recreate the app to apply).
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$DEPLOY_DIR/.env"
EXAMPLE_FILE="$DEPLOY_DIR/.env.example"
IMAGE_TAG="${1:-ghcr.io/mohaned178/identik:v0.1.0}"

[ "$(id -u)" -eq 0 ] || { echo "run as root: su - root" >&2; exit 1; }
[ -f "$EXAMPLE_FILE" ] || { echo "missing $EXAMPLE_FILE" >&2; exit 1; }

prompt() { # prompt label default
  local label="$1" default="${2:-}" value=""
  if [ -n "$default" ]; then
    read -r -p "    ${label} [${default}]: " value
    printf '%s\n' "${value:-$default}"
  else
    read -r -p "    ${label}: " value
    printf '%s\n' "$value"
  fi
}

echo "==> generating deploy/.env (image ${IMAGE_TAG})"
install -m 0600 -o root -g root "$EXAMPLE_FILE" "$ENV_FILE"

# --- One secret, used twice: PostgreSQL password ---------------------------
if [ -n "${POSTGRES_PASSWORD:-}" ]; then
  db_password="$POSTGRES_PASSWORD"
  echo "    POSTGRES_PASSWORD from environment (not shown)"
else
  db_password="$(openssl rand -hex 24)"
  echo "    POSTGRES_PASSWORD generated: ${db_password}"
fi
case "$db_password" in
  *[!0-9a-f]*) echo "ERROR: POSTGRES_PASSWORD must be hex (openssl rand -hex 24)." >&2; exit 1 ;;
esac

# --- Signing JWKS from the real artifact -----------------------------------
if [ -n "${IDENTIK_SIGNING_JWKS:-}" ]; then
  jwks="$IDENTIK_SIGNING_JWKS"
  echo "    IDENTIK_SIGNING_JWKS from environment"
else
  if ! docker image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
    echo "    pulling ${IMAGE_TAG} for keygen"
    docker pull "$IMAGE_TAG" >/dev/null
  fi
  jwks="$(docker run --rm "$IMAGE_TAG" keygen)"
  echo "    IDENTIK_SIGNING_JWKS minted by ${IMAGE_TAG} keygen"
fi
case "$jwks" in
  '['*']'*) ;;
  *) echo "ERROR: IDENTIK_SIGNING_JWKS is not a JSON array." >&2; exit 1 ;;
esac

# --- Operator-only inputs ----------------------------------------------------
hostname="${IDENTIK_HOSTNAME:-}"
while [ -z "$hostname" ]; do
  hostname="$(prompt "Instance hostname (dedicated subdomain, e.g. id.example.com)")"
done
case "$hostname" in
  *://*|*/*) echo "ERROR: invalid hostname '${hostname}'." >&2; exit 1 ;;
esac

echo "    SMTP relay (MAIL_TRANSPORT_BINDING=smtp is already set)"
smtp_host="${SMTP_HOST:-$(prompt "SMTP_HOST (relay hostname)")}"
smtp_port="${SMTP_PORT:-$(prompt "SMTP_PORT [587]" 587)}"
smtp_user="${SMTP_USER:-$(prompt "SMTP_USER (or blank for an unauthenticated relay)")}"
mail_from="${MAIL_FROM:-$(prompt "MAIL_FROM (e.g. 'IdentiK <no-reply@your-domain.com>')")}"
smtp_password="${SMTP_PASSWORD:-}"
if [ -n "$smtp_user" ] && [ -z "$smtp_password" ]; then
  echo "    AUTH: ${smtp_user}"
  smtp_password="$(prompt "SMTP_PASSWORD")"
fi

# --- Write the file -----------------------------------------------------------
tmp="$ENV_FILE.tmp"
: > "$tmp"
while IFS= read -r line; do
  case "$line" in
    POSTGRES_PASSWORD=*)     printf 'POSTGRES_PASSWORD=%s\n' "$db_password" ;;
    IDENTIK_IMAGE_TAG=*)     printf 'IDENTIK_IMAGE_TAG=%s\n' "$IMAGE_TAG" ;;
    IDENTIK_HOSTNAME=*)      printf 'IDENTIK_HOSTNAME=%s\n' "$hostname" ;;
    IDENTIK_SIGNING_JWKS=*)  printf 'IDENTIK_SIGNING_JWKS=%s\n' "$jwks" ;;
    SMTP_HOST=*)             printf 'SMTP_HOST=%s\n' "$smtp_host" ;;
    SMTP_PORT=*)             printf 'SMTP_PORT=%s\n' "$smtp_port" ;;
    MAIL_FROM=*)             printf 'MAIL_FROM=%s\n' "$mail_from" ;;
    '# SMTP_USER='*)         [ -n "$smtp_user" ] && printf 'SMTP_USER=%s\n' "$smtp_user" || printf '%s\n' "$line" ;;
    '# SMTP_PASSWORD='*)     [ -n "$smtp_password" ] && printf 'SMTP_PASSWORD=%s\n' "$smtp_password" || printf '%s\n' "$line" ;;
    *)                       printf '%s\n' "$line" ;;
  esac
done < "$EXAMPLE_FILE" > "$tmp"

if [ -n "$smtp_user" ] && [ -z "$smtp_password" ]; then
  echo "    WARNING: SMTP_USER is set but SMTP_PASSWORD is empty — the app refuses" >&2
  echo "             to boot with one without the other. Re-run setup-env.sh to set both." >&2
fi

mv "$tmp" "$ENV_FILE"
chown root:root "$ENV_FILE"
chmod 0600 "$ENV_FILE"

echo
echo "==> deploy/.env written:"
printf '    IDENTIK_HOSTNAME      %s\n' "$hostname"
printf '    IDENTIK_IMAGE_TAG     %s\n' "$IMAGE_TAG"
printf '    SMTP_HOST             %s:%s\n' "$smtp_host" "$smtp_port"
printf '    MAIL_FROM             %s\n' "$mail_from"
printf '    POSTGRES_PASSWORD     %s\n' "${db_password}  <-- record this if you need to log in as the db superuser"
printf '    IDENTIK_SIGNING_JWKS  %s\n' "$(printf '%s' "$jwks" | cut -c1-40)…"

if [ -f "$DEPLOY_DIR/.env.example" ]; then
  git -C "$(dirname "$DEPLOY_DIR")" check-ignore -q "$ENV_FILE" \
    && echo "    confirmed gitignored (not tracked)" \
    || echo "    WARNING: deploy/.env is not gitignored — verify .gitignore."
fi
echo "    Next: bash deploy/first-deploy.sh"
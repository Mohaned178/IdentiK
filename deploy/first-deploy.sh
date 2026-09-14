#!/usr/bin/env bash
#
# First deploy of the live Instance (Milestone 5.5) plus the first-boot
# capture (5.6): boots the database and proxy, runs the tested deploy script,
# then prints the one-time setup token so the Bootstrap Ceremony can complete.
#
#   bash deploy/first-deploy.sh
#
# Preconditions (all produced by setup-env.sh / provision.sh):
#   - checkout at /opt/identik pinned exactly to the released tag
#   - deploy/.env present (root 0600) with IDENTIK_HOSTNAME and IDENTIK_IMAGE_TAG
#   - DNS for IDENTIK_HOSTNAME already points at this host
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$DEPLOY_DIR/.env"

[ -f "$ENV_FILE" ] || { echo "deploy/.env missing — run setup-env.sh first" >&2; exit 1; }
[ -f "$DEPLOY_DIR/docker-compose.yml" ] || { echo "missing docker-compose.yml" >&2; exit 1; }

image="$(sed -n 's/^IDENTIK_IMAGE_TAG=//p' "$ENV_FILE" | tail -n 1)"
hostname="$(sed -n 's/^IDENTIK_HOSTNAME=//p' "$ENV_FILE" | tail -n 1)"
[ -n "$image" ] || { echo "IDENTIK_IMAGE_TAG missing from deploy/.env" >&2; exit 1; }
[ -n "$hostname" ] || { echo "IDENTIK_HOSTNAME missing from deploy/.env" >&2; exit 1; }

tag="${image##*:}"
case "$tag" in
  v*) ;;
  *) echo "IDENTIK_IMAGE_TAG does not end in a version tag: ${image}" >&2; exit 1 ;;
esac

echo "==> first install: image ${image}, hostname ${hostname}"
echo "    DNS must already resolve ${hostname} to this host. Verify now:"
getent hosts "$hostname" || true

echo "==> booting postgres and proxy first"
(cd "$DEPLOY_DIR" && docker compose up -d postgres proxy)

echo "==> running the tested deploy sequence (pull -> migrate -> app -> readiness)"
"$DEPLOY_DIR/deploy.sh" "$tag"

echo "==> first-boot state"
sleep 2
curl -fsSk --resolve "${hostname}:443:127.0.0.1" "https://${hostname}/api/setup/status" \
  || { echo "setup status endpoint not reachable yet" >&2; }

echo
echo "==> capturing the one-time setup token"
token="$(cd "$DEPLOY_DIR" && docker compose logs app 2>/dev/null | grep -oh 'setup token[^A-Za-z0-9_-]*[A-Za-z0-9_-]\{24,\}' | tail -n 1 | sed 's/.*setup token[^A-Za-z0-9_-]*//' || true)"
if [ -z "$token" ]; then
  echo "    setup token not found in the app log."
  echo "    Recover it manually (it is shown only once):"
  echo "      cd deploy && docker compose logs app | grep -i 'setup token'"
  echo "    A restart before the ceremony completes forces a reinstall (deploy/README.md §6)."
  exit 1
fi
echo "    ${token}"

cat <<EOF

==> next: complete the Bootstrap Ceremony now (one-time, token is not shown again).
    curl -fsS -X POST "https://${hostname}/api/setup?token=${token}" \\
      -H 'Content-Type: application/json' \\
      -d '{"organizationName":"Acme","email":"owner@example.com","password":"<strong-secret>","name":"Owner Name"}'
    Then sign in, register the first Application, and capture the Client Secret.
    See deploy/README.md §6-7 for the rest of the operator curl runbook.
EOF
#!/usr/bin/env bash
#
# Set up the external uptime probe for the live Instance (Milestone 5.8).
# This script cannot create the monitor account (provider of your choice);
# it verifies the endpoint from here, prints the exact values to paste into
# the monitor, and checks the certificate expiry date.
#
#   bash deploy/probe-setup.sh
#
# Provider notes (all pasted with the values below):
#   - Any monitor with a "keyword" check, 5-minute interval, alert after 2
#     consecutive failures, operator email, and TLS/SSL expiry alerting.
#   - The keyword check MUST treat a body without "database":{"ok":true} as
#     down (readiness, not mere reachability).
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$DEPLOY_DIR/.env"
[ -f "$ENV_FILE" ] || { echo "deploy/.env missing" >&2; exit 1; }

hostname="$(sed -n 's/^IDENTIK_HOSTNAME=//p' "$ENV_FILE" | tail -n 1)"
[ -n "$hostname" ] || { echo "IDENTIK_HOSTNAME missing from deploy/.env" >&2; exit 1; }
url="https://${hostname}/health/ready"

echo "==> verifying ${url} from this host"
expected='"database":{"ok":true}'
for attempt in 1 2 3; do
  body="$(curl -fsS --max-time 10 "$url" 2>/dev/null || true)"
  case "$body" in
    *"$expected"*)
      echo "    OK: readiness reports database.ok=true"
      echo "$body"
      break
      ;;
    *)
      if [ "$attempt" = 3 ]; then
        echo "ERROR: readiness did not return database.ok=true. Body: ${body:-<none>}" >&2
        exit 1
      fi
      echo "    not ready (attempt ${attempt}/3); retrying in 10s"
      sleep 10
      ;;
  esac
done

echo
echo "==> certificate expiry"
expiry="$( (echo | timeout 10 openssl s_client -servername "$hostname" -connect "${hostname}:443" 2>/dev/null) \
  | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2 || true)"
echo "    ${expiry:-<could not read>}"

cat <<EOF

==> configuration to paste into your external monitor
    URL:        ${url}
    Interval:   5 minutes
    Alert after: 2 consecutive failures
    Alert to:   <your email>
    Keyword:    database.ok true      (i.e. the body must contain:
                "${expected}")
    TLS expiry alert: on

==> open a firewall hole check from OUTSIDE the host to prove the probe will
    see it (port 443 reachable publicly). A DNS rebind / SSRF-protected check
    service or simply your phone on mobile data hitting the URL works.
EOF
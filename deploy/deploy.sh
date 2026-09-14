#!/usr/bin/env bash
#
# Deploy one released tag on this host. The runbook is deploy/README.md.
#
#   ./deploy/deploy.sh v0.1.1
#
# Preconditions: the checkout is clean and already at <tag>, and deploy/.env
# names that tag's image. The script pulls, applies migrations, recreates the
# app, and verifies readiness through the proxy. On failure it prints the
# rollback command.
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DEPLOY_DIR/.." && pwd)"
APP_SERVICE="app"
READY_TIMEOUT_SECONDS="${DEPLOY_READY_TIMEOUT_SECONDS:-180}"
READY_POLL_SECONDS="${DEPLOY_READY_POLL_SECONDS:-5}"

previous_image=""
previous_git_tag=""
hostname=""

print_rollback() {
  if [ -z "$previous_image" ]; then
    echo "No app was running before this deploy; there is nothing to roll back to." >&2
    return
  fi
  echo "Rollback to ${previous_image}:" >&2
  echo "  git -C \"${REPO_ROOT}\" checkout ${previous_git_tag}" >&2
  echo "  sed -i 's|^IDENTIK_IMAGE_TAG=.*|IDENTIK_IMAGE_TAG=${previous_image}|' \"${DEPLOY_DIR}/.env\"" >&2
  echo "  (cd \"${DEPLOY_DIR}\" && docker compose up -d --force-recreate ${APP_SERVICE})" >&2
  if [ -n "$hostname" ]; then
    echo "  curl -fsSk --resolve \"${hostname}:443:127.0.0.1\" \"https://${hostname}/health/ready\"" >&2
  fi
}

fail() {
  echo "DEPLOY FAILED: $*" >&2
  print_rollback
  exit 1
}

target_tag="${1:-}"
[ -n "$target_tag" ] || fail "usage: deploy.sh <tag> (for example: deploy.sh v0.1.1)"

echo "==> asserting a clean checkout exactly at ${target_tag}"
[ -f "$DEPLOY_DIR/.env" ] || fail "deploy/.env is missing"
[ -f "$DEPLOY_DIR/docker-compose.yml" ] || fail "deploy/docker-compose.yml is missing"
[ -z "$(git -C "$REPO_ROOT" status --porcelain)" ] || fail "the checkout has uncommitted changes"
head_tag="$(git -C "$REPO_ROOT" describe --tags --exact-match HEAD 2>/dev/null || true)"
[ "$head_tag" = "$target_tag" ] || fail "HEAD is at '${head_tag:-<no tag>}', not '${target_tag}'"

image="$(sed -n 's/^IDENTIK_IMAGE_TAG=//p' "$DEPLOY_DIR/.env" | tail -n 1)"
hostname="$(sed -n 's/^IDENTIK_HOSTNAME=//p' "$DEPLOY_DIR/.env" | tail -n 1)"
[ -n "$image" ] || fail "IDENTIK_IMAGE_TAG is not set in deploy/.env"
[ -n "$hostname" ] || fail "IDENTIK_HOSTNAME is not set in deploy/.env"
case "$image" in
  *":${target_tag}") ;;
  *) fail "deploy/.env runs '${image}', which does not match '${target_tag}'" ;;
esac

running_container="$(cd "$DEPLOY_DIR" && docker compose ps -q "$APP_SERVICE" 2>/dev/null || true)"
if [ -n "$running_container" ]; then
  previous_image="$(docker inspect --format '{{.Config.Image}}' "$running_container" 2>/dev/null || true)"
fi
if [ -n "$previous_image" ]; then
  previous_git_tag="${previous_image##*:}"
  echo "==> previous running image: ${previous_image}"
else
  echo "==> no previous running app found (first deploy)"
fi

echo "==> pulling ${image}"
(cd "$DEPLOY_DIR" && docker compose pull) || fail "docker compose pull failed"

echo "==> applying migrations"
(cd "$DEPLOY_DIR" && docker compose run --rm "$APP_SERVICE" migrate) || fail "migrations failed"

echo "==> recreating ${APP_SERVICE}"
(cd "$DEPLOY_DIR" && docker compose up -d --force-recreate "$APP_SERVICE") || fail "recreating ${APP_SERVICE} failed"

echo "==> verifying readiness at https://${hostname}/health/ready"
deadline=$((SECONDS + READY_TIMEOUT_SECONDS))
while :; do
  body="$(curl -fsSk --resolve "${hostname}:443:127.0.0.1" "https://${hostname}/health/ready" 2>/dev/null || true)"
  case "$body" in
    *'"database":{"ok":true}'*)
      echo "==> deployed ${image}"
      exit 0
      ;;
  esac
  if [ "$SECONDS" -ge "$deadline" ]; then
    fail "readiness did not report database.ok=true within ${READY_TIMEOUT_SECONDS}s (last body: ${body:-<none>})"
  fi
  echo "    not ready yet (${body:-<no response>}); retrying in ${READY_POLL_SECONDS}s"
  sleep "$READY_POLL_SECONDS"
done

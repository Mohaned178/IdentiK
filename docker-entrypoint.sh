#!/bin/sh
set -eu

case "${1:-server}" in
  server)
    exec node dist/main.js
    ;;
  migrate)
    exec npx prisma migrate deploy
    ;;
  keygen)
    exec node dist/keygen.js
    ;;
  *)
    exec "$@"
    ;;
esac

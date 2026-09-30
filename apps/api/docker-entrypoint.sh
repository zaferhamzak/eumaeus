#!/bin/sh
# api     -> apply pending database migrations, then serve the API
# worker  -> run the background worker (sync, analysis, actions, alerts)
# other   -> run it as a command (e.g. "node dist/scripts/sync-once.js")
set -e
case "$1" in
  api)
    npx prisma migrate deploy
    exec node dist/server.js
    ;;
  worker)
    exec node dist/worker.js
    ;;
  *)
    exec "$@"
    ;;
esac

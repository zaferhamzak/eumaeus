#!/bin/sh
# Eumaeus fast run — the whole app for local development in one command.
#
#   scripts/fastrun.sh            start API, worker and web in this terminal
#                                 (prefixed logs; Ctrl+C stops all three)
#   scripts/fastrun.sh --bg       start them in the background (logs in .run/;
#                                 API and worker restart on their own if they exit)
#   scripts/fastrun.sh stop       stop the background services
#   scripts/fastrun.sh status     what is running, and is it healthy
#
# Before starting it checks Postgres and Redis (on macOS it starts the
# Homebrew services if they are down), and applies pending database
# migrations. Ports: API 3000, web 3001.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
run="$root/.run"
api_port=3000
web_port=3001
mkdir -p "$run"
cd "$root"

say() { printf '\033[1m▸ %s\033[0m\n' "$*"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

pid_alive() { [ -f "$run/$1.pid" ] && kill -0 "$(cat "$run/$1.pid")" 2>/dev/null; }

status() {
  for svc in api worker web; do
    if pid_alive "$svc"; then printf '%-7s running (pid %s)\n' "$svc" "$(cat "$run/$svc.pid")"; else printf '%-7s stopped\n' "$svc"; fi
  done
  ready="$(curl -s -m 3 "http://localhost:$api_port/api/v1/ready" 2>/dev/null || true)"
  case "$ready" in
    *'"status":"ok"'*'"worker":{"status":"ok"'*) echo "health  API ready, worker heartbeat ok" ;;
    *'"status":"ok"'*) echo "health  API ready, worker NOT reporting" ;;
    *) echo "health  API not answering on :$api_port" ;;
  esac
  code="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "http://localhost:$web_port/login" 2>/dev/null || true)"
  [ "$code" = 200 ] && echo "web     http://localhost:$web_port" || echo "web     not answering on :$web_port"
}

stop() {
  for svc in web worker api; do
    if pid_alive "$svc"; then
      pid="$(cat "$run/$svc.pid")"
      # The pid is the process-group leader started below; signal the group
      # so pnpm, tsx and node all get it (the worker drains gracefully).
      kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
      i=0; while kill -0 "$pid" 2>/dev/null && [ $i -lt 30 ]; do sleep 1; i=$((i + 1)); done
      echo "$svc stopped"
    fi
    rm -f "$run/$svc.pid"
  done
}

port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

preflight() {
  [ -f apps/api/.env ] || fail "apps/api/.env is missing — copy apps/api/.env.example and fill it in"
  [ -d node_modules ] || { say "installing dependencies"; pnpm install; }
  [ -x apps/api/node_modules/.bin/tsx ] || { say "restoring dev dependencies"; pnpm install; }

  if ! pg_isready -q 2>/dev/null; then
    command -v brew >/dev/null && { say "starting Postgres"; brew services start postgresql@16 >/dev/null 2>&1 || true; sleep 3; }
    pg_isready -q 2>/dev/null || fail "Postgres is not reachable (start it, or: docker compose up -d)"
  fi
  if ! redis-cli ping >/dev/null 2>&1; then
    command -v brew >/dev/null && { say "starting Redis"; brew services start redis >/dev/null 2>&1 || true; sleep 2; }
    redis-cli ping >/dev/null 2>&1 || fail "Redis is not reachable (start it, or: docker compose up -d)"
  fi

  for p in $api_port $web_port; do port_busy "$p" && fail "port $p is already in use (scripts/fastrun.sh status / stop)"; done

  say "applying database migrations"
  (cd apps/api && npx prisma migrate deploy >/dev/null && npx prisma generate >/dev/null) || fail "migrations failed"
}

wait_ready() {
  i=0
  until curl -sf -m 2 "http://localhost:$api_port/api/v1/ready" >/dev/null 2>&1; do
    i=$((i + 1)); [ $i -lt 60 ] || fail "API did not become ready (see $1)"; sleep 1
  done
  i=0
  until [ "$(curl -s -o /dev/null -m 3 -w '%{http_code}' "http://localhost:$web_port/login" 2>/dev/null)" = 200 ]; do
    i=$((i + 1)); [ $i -lt 90 ] || fail "web did not start (see $1)"; sleep 1
  done
}

# Background services have nobody watching them, so the API and the worker
# are restarted if they exit on their own (a crash must not leave mail
# unsynced overnight). A stop's TERM reaches the whole group; the trap runs
# once the service has finished shutting down, and ends the loop.
supervise() {
  # +e: a crashed service is exactly what this loop is for; +m: keep the
  # service in this process group so a stop still reaches it.
  set +em
  trap 'exit 0' TERM INT HUP
  while :; do
    "$@"
    code=$?
    echo "[fastrun] $(date '+%Y-%m-%d %H:%M:%S') '$*' exited with $code — restarting in 5 s"
    sleep 5
  done
}

start_bg() {
  preflight
  # set -m: each service becomes its own process group, so stop can signal
  # pnpm and everything it spawned.
  set -m
  (cd apps/api && supervise pnpm api) > "$run/api.log" 2>&1 & echo $! > "$run/api.pid"
  (cd apps/api && supervise pnpm worker) > "$run/worker.log" 2>&1 & echo $! > "$run/worker.pid"
  (cd apps/web && exec pnpm exec next dev -p "$web_port") > "$run/web.log" 2>&1 & echo $! > "$run/web.pid"
  set +m
  say "waiting for the services"
  wait_ready "$run/*.log"
  status
  echo "logs: $run/{api,worker,web}.log   stop: pnpm fastrun:stop"
}

start_fg() {
  preflight
  prefix() { awk -v p="$1" '{ printf "%s %s\n", p, $0; fflush() }'; }
  # Each service in its own process group (set -m), remembered, so stopping
  # works however the script is ended: Ctrl+C in a terminal, a TERM from a
  # process manager, or a SIGINT that a non-interactive shell would ignore.
  set -m
  (cd apps/api && pnpm api 2>&1 | prefix "$(printf '\033[36m[api]   \033[0m')") & api_pid=$!
  (cd apps/api && pnpm worker 2>&1 | prefix "$(printf '\033[35m[worker]\033[0m')") & worker_pid=$!
  (cd apps/web && pnpm exec next dev -p "$web_port" 2>&1 | prefix "$(printf '\033[33m[web]   \033[0m')") & web_pid=$!
  set +m
  shutdown() {
    trap - INT TERM HUP EXIT
    echo; say "stopping"
    for pid in $web_pid $worker_pid $api_pid; do kill -TERM -- "-$pid" 2>/dev/null || true; done
    i=0; while [ $i -lt 30 ] && { kill -0 "$api_pid" 2>/dev/null || kill -0 "$worker_pid" 2>/dev/null || kill -0 "$web_pid" 2>/dev/null; }; do sleep 1; i=$((i + 1)); done
    for pid in $web_pid $worker_pid $api_pid; do kill -KILL -- "-$pid" 2>/dev/null || true; done
    exit 0
  }
  trap shutdown INT TERM HUP EXIT
  if wait_ready "the logs above"; then say "ready — http://localhost:$web_port  (API :$api_port)  Ctrl+C to stop"; fi
  # Keep running until a service exits or we're told to stop.
  while kill -0 "$api_pid" 2>/dev/null && kill -0 "$worker_pid" 2>/dev/null && kill -0 "$web_pid" 2>/dev/null; do sleep 1; done
  say "a service exited — stopping the others"
  shutdown
}

case "${1:-}" in
  --bg | start) start_bg ;;
  stop) stop ;;
  status) status ;;
  "" | up) start_fg ;;
  *) echo "usage: scripts/fastrun.sh [--bg | stop | status]" >&2; exit 2 ;;
esac

#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE="${ENV_FILE:-.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
WITH_CADDY="${WITH_CADDY:-1}"
WITH_POSTGRES="${WITH_POSTGRES:-0}"

compose=(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE")
if [[ "$WITH_CADDY" == "1" ]]; then
  compose+=(--profile caddy)
fi
if [[ "$WITH_POSTGRES" == "1" ]]; then
  compose+=(--profile postgres)
fi

echo "Updating Kontur from Git…"
git pull --ff-only

echo "Rebuilding and restarting containers…"
"${compose[@]}" up -d --build

echo "Waiting for /health…"
for _ in $(seq 1 30); do
  if "${compose[@]}" exec -T churn-risk python -c \
    'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=3)' \
    >/dev/null 2>&1; then
    "${compose[@]}" ps
    echo "Kontur is healthy."
    exit 0
  fi
  sleep 2
done

"${compose[@]}" ps
"${compose[@]}" logs --tail=120 churn-risk
echo "Kontur did not become healthy in time." >&2
exit 1

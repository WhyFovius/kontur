#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE="${ENV_FILE:-.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

if grep -Eq '^[[:space:]]*DATABASE_URL=[^[:space:]#]+' "$ENV_FILE"; then
  echo "DATABASE_URL is set: back up PostgreSQL with pg_dump instead of this SQLite script." >&2
  exit 2
fi

mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%d-%H%M%S)"
container_backup="/app/data/.backup-${stamp}.db"
host_backup="${BACKUP_DIR}/kontur-${stamp}.db"

compose=(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE")

cleanup() {
  "${compose[@]}" exec -T churn-risk rm -f "$container_backup" >/dev/null 2>&1 || true
}
trap cleanup EXIT

"${compose[@]}" exec -T churn-risk python -c \
  'import sqlite3, sys; src=sqlite3.connect("/app/data/churn.db"); dst=sqlite3.connect(sys.argv[1]); src.backup(dst); dst.close(); src.close()' \
  "$container_backup"
# Stream the file out instead of `docker compose cp`, so the host copy is
# owned by the invoking user rather than the container's appuser UID.
"${compose[@]}" exec -T churn-risk cat "$container_backup" > "${host_backup}.tmp"
chmod 600 "${host_backup}.tmp"
mv "${host_backup}.tmp" "$host_backup"

find "$BACKUP_DIR" -maxdepth 1 -type f -name 'kontur-*.db' -mtime "+${RETENTION_DAYS}" -delete

echo "Backup written to ${host_backup}"

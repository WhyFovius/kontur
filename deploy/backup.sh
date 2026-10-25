#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE="${ENV_FILE:-.env.production}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

if grep -Eq '^[[:space:]]*DATABASE_URL=[^[:space:]#]+' "$ENV_FILE"; then
  echo "DATABASE_URL is set: back up PostgreSQL with pg_dump and archive /app/data/workspaces separately." >&2
  exit 2
fi

mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%d-%H%M%S)"
container_backup_dir="/app/data/.backup-${stamp}"
host_backup="${BACKUP_DIR}/kontur-${stamp}.tar.gz"

compose=(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE")

cleanup() {
  "${compose[@]}" exec -T churn-risk rm -rf "$container_backup_dir" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Make an online, transactionally consistent copy of the registry/main
# SQLite database and of every isolated demo-preview workspace. Copying
# live .db files directly could miss pages that are still in their WALs.
"${compose[@]}" exec -T churn-risk python -c '
import sqlite3
import sys
from pathlib import Path

root = Path("/app/data")
out = Path(sys.argv[1])
(out / "workspaces").mkdir(parents=True, exist_ok=True)

def backup(source: Path, destination: Path) -> None:
    src = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    try:
        dst = sqlite3.connect(destination)
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()

backup(root / "churn.db", out / "churn.db")
workspace_dir = root / "workspaces"
if workspace_dir.is_dir():
    for source in sorted(workspace_dir.glob("*.db")):
        backup(source, out / "workspaces" / source.name)
' "$container_backup_dir"

# Stream a tar.gz out with Python instead of `docker compose cp`, so the
# host copy is owned by the invoking user rather than the container UID.
"${compose[@]}" exec -T churn-risk python -c '
import sys
import tarfile

with tarfile.open(fileobj=sys.stdout.buffer, mode="w:gz") as archive:
    archive.add(sys.argv[1], arcname=".")
' "$container_backup_dir" > "${host_backup}.tmp"
chmod 600 "${host_backup}.tmp"
mv "${host_backup}.tmp" "$host_backup"

find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'kontur-*.db' -o -name 'kontur-*.tar.gz' \) -mtime "+${RETENTION_DAYS}" -delete

echo "Backup written to ${host_backup}"

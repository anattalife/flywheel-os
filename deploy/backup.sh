#!/bin/bash
# Nightly backup of the database and photos (installed as a cron job by install.sh).
# Restore a database backup:
#   gunzip -c FILE.sql.gz | sudo docker compose -f deploy/docker-compose.yml --env-file .env exec -T db psql -U postgres flywheel
set -euo pipefail
cd "$(dirname "$0")/.."
dc() { docker compose -f deploy/docker-compose.yml --env-file .env "$@"; }
DIR=/var/backups/flywheel; mkdir -p "$DIR"; chmod 700 "$DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
dc exec -T db pg_dump -U postgres --no-owner flywheel | gzip > "$DIR/db-$STAMP.sql.gz"
dc exec -T api tar czf - -C /app/data . > "$DIR/photos-$STAMP.tgz"
find "$DIR" -type f -mtime +14 -delete
echo "backup ok $STAMP"

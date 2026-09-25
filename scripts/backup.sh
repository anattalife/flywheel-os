#!/bin/sh
# Nightly database backup to a local folder, keeping the last 14 days.
# Lightsail managed databases also take automatic daily snapshots (7 days); this
# gives you your own copy too. Run from the instance, e.g. in crontab:
#   15 3 * * * /home/ubuntu/flywheel-os/scripts/backup.sh >> /home/ubuntu/backup.log 2>&1
# Restore:  gunzip -c FILE.sql.gz | psql "$MIGRATION_DATABASE_URL"
set -eu
cd "$(dirname "$0")/.."
. ./.env
DIR="${BACKUP_DIR:-$HOME/flywheel-backups}"
mkdir -p "$DIR"
FILE="$DIR/flywheel-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
docker run --rm postgres:16 pg_dump --no-owner --no-privileges "$MIGRATION_DATABASE_URL" | gzip > "$FILE"
# Uploaded photos (only when stored on the instance rather than in S3).
if [ "${STORAGE_PROVIDER:-local}" = "local" ]; then
  docker run --rm -v flywheel-os_uploads:/data -v "$DIR":/out alpine tar czf "/out/uploads-$(date -u +%Y%m%d).tgz" -C /data .
fi
find "$DIR" -name 'flywheel-*.sql.gz' -mtime +14 -delete
find "$DIR" -name 'uploads-*.tgz' -mtime +14 -delete
# Optional off-server copy: set BACKUP_S3_URI=s3://bucket/path and install the AWS CLI.
if [ -n "${BACKUP_S3_URI:-}" ]; then aws s3 cp "$FILE" "$BACKUP_S3_URI/"; fi
echo "backup ok: $FILE"

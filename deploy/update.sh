#!/bin/bash
# Get the newest version from GitHub and restart. Your data and settings are kept.
#   sudo bash deploy/update.sh
set -euo pipefail
cd "$(dirname "$0")/.."
dc() { docker compose -f deploy/docker-compose.yml --env-file .env "$@"; }
git pull --ff-only
dc build
dc up -d db
dc run --rm migrate
dc up -d api worker caddy
sleep 5
dc exec -T api wget -qO- http://localhost:3000/health && echo && echo "Updated."

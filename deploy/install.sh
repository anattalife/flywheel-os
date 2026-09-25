#!/bin/bash
# Flywheel OS: one-command install on a Lightsail (Ubuntu or Debian) server.
#   sudo bash deploy/install.sh
# Asks five questions, then sets up everything: Docker, the database, the app,
# HTTPS, nightly backups, and your owner login.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
dc() { docker compose -f deploy/docker-compose.yml --env-file .env "$@"; }
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

if [ "$(id -u)" != 0 ]; then echo "Run it with sudo:  sudo bash deploy/install.sh"; exit 1; fi

say "1/6  Docker"
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
echo "ok"

# Small servers need swap to build the app.
mem_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
if [ "$mem_kb" -lt 3000000 ] && ! swapon --show | grep -q .; then
  say "Adding 2 GB of swap (this server has little memory)"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

if [ -f .env ]; then
  say "2/6  Settings: already set up (.env exists), keeping them"
  FIRST=no
else
  FIRST=yes
  say "2/6  A few questions"
  echo "Your domain must already point at this server (an A record for it, and one for www)."
  read -rp "Domain for your business (like mybusiness.com): " DOMAIN
  DOMAIN=$(echo "$DOMAIN" | tr 'A-Z' 'a-z' | sed -E 's#^https?://##; s#/.*$##; s#^www\.##')
  read -rp "Business name: " BIZ
  read -rp "Your email (your login): " EMAIL
  while true; do
    read -rsp "Choose a password (10+ characters): " PASS; echo
    [ ${#PASS} -ge 10 ] && break; echo "Too short, try again."
  done
  read -rp "Your mobile number, 10 digits (for reset codes; Enter to skip): " MOBILE
  MOBILE=$(echo "$MOBILE" | tr -cd '0-9'); [ ${#MOBILE} -eq 11 ] && MOBILE=${MOBILE:1}
  [ ${#MOBILE} -eq 10 ] && MOBILE="+1$MOBILE" || MOBILE=""
  read -rp "Time zone [America/Detroit]: " TZONE; TZONE=${TZONE:-America/Detroit}

  rnd() { openssl rand -hex 32; }
  PG=$(rnd); APPPW=$(rnd)
  cat > .env <<ENV
NODE_ENV=production
PORT=3000
PUBLIC_BASE_URL=https://$DOMAIN
APP_DOMAIN=$DOMAIN
ACME_EMAIL=$EMAIL
ADMIN_TOKEN=$(rnd)
APP_SECRET=$(rnd)
MONITOR_TOKEN=$(rnd)
POSTGRES_PASSWORD=$PG
MIGRATION_DATABASE_URL=postgres://postgres:$PG@db:5432/flywheel
DATABASE_URL=postgres://flywheel_app:$APPPW@db:5432/flywheel
APP_DB_PASSWORD=$APPPW
DATABASE_SSL=off
STORAGE_PROVIDER=local
STORAGE_DIR=/app/data/uploads
# Switched on later, one at a time (see docs/LIVE-TRIAL.md):
MESSAGING_PROVIDER=dev
PAYMENTS_PROVIDER=dev
EMAIL_PROVIDER=dev
EMAIL_FROM=hello@$DOMAIN
AI_PROVIDER=none
ALERT_EMAIL=$EMAIL
ENV
  chmod 600 .env
  echo "Saved. (Settings are in $ROOT/.env)"
fi

say "3/6  Building the app (a few minutes the first time)"
dc build

say "4/6  Database"
dc up -d db
dc run --rm migrate

say "5/6  Starting"
dc up -d api worker caddy
for i in $(seq 1 60); do
  dc exec -T api wget -qO- http://localhost:3000/health >/dev/null 2>&1 && break; sleep 2
done
dc exec -T api wget -qO- http://localhost:3000/health >/dev/null || { echo "The app didn't start. Showing its log:"; dc logs --tail 40 api; exit 1; }

if [ "$FIRST" = yes ]; then
  dc exec -T -e BIZ="$BIZ" -e EMAIL="$EMAIL" -e PASS="$PASS" -e MOBILE="$MOBILE" -e TZONE="$TZONE" -e DOMAIN="$DOMAIN" api node -e '
    const e = process.env;
    const owner = { email: e.EMAIL, password: e.PASS, ...(e.MOBILE ? { phone: e.MOBILE } : {}) };
    fetch("http://localhost:3000/admin/businesses", { method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + e.ADMIN_TOKEN },
      body: JSON.stringify({ name: e.BIZ, timezone: e.TZONE, custom_domain: e.DOMAIN, owner }) })
    .then(async (r) => { const b = await r.json(); if (!r.ok) { console.error("Could not create your login:", b.error || b); process.exit(1); } console.log("Your account is ready."); });
  '
fi

say "6/6  Nightly backups"
cat > /etc/cron.d/flywheel-backup <<CRON
15 3 * * * root $ROOT/deploy/backup.sh >> /var/log/flywheel-backup.log 2>&1
CRON
chmod +x deploy/*.sh
echo "Every night at 3:15, kept 14 days, in /var/backups/flywheel"

DOMAIN=$(grep '^PUBLIC_BASE_URL=' .env | cut -d/ -f3)
say "Done!"
echo "  Your website:   https://$DOMAIN"
echo "  Your app:       https://$DOMAIN/app   (sign in with your email and password)"
echo
echo "  If the page doesn't load: in Lightsail open this instance > Networking and make sure"
echo "  the firewall allows HTTPS (443), and that your domain points at this server's IP."
echo "  To update later:  sudo bash $ROOT/deploy/update.sh"

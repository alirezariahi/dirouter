#!/usr/bin/env sh
# Creates a complete .env with random secrets from .env.example.
# Usage:  ./scripts/bootstrap.sh [--domain example.com] [--prod] [--force]
set -eu

cd "$(dirname "$0")/.."

DOMAIN=localhost
NODE_ENV=development
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --prod) NODE_ENV=production; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,3p' "$0"; exit 0 ;;
    *) echo "گزینهٔ ناشناخته / unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ -f .env ] && [ "$FORCE" -ne 1 ]; then
  echo ".env از قبل وجود دارد؛ برای بازنویسی --force بدهید / .env exists, use --force" >&2
  exit 1
fi

command -v openssl >/dev/null 2>&1 || { echo "openssl لازم است / openssl is required" >&2; exit 1; }

rand_b64() { openssl rand -base64 "$1" | tr -d '\n'; }
rand_hex() { openssl rand -hex "$1"; }

POSTGRES_PASSWORD=$(rand_hex 24)
MASTER_KEY="1:$(rand_b64 32)"
KEY_PEPPER=$(rand_hex 32)
JWT_SECRET=$(rand_hex 32)
INTERNAL_TOKEN=$(rand_hex 32)

umask 077
sed \
  -e "s|^DOMAIN=.*|DOMAIN=${DOMAIN}|" \
  -e "s|^NODE_ENV=.*|NODE_ENV=${NODE_ENV}|" \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${POSTGRES_PASSWORD}|" \
  -e "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://dirouter:${POSTGRES_PASSWORD}@localhost:55432/dirouter|" \
  -e "s|^MASTER_KEY=.*|MASTER_KEY=${MASTER_KEY}|" \
  -e "s|^KEY_PEPPER=.*|KEY_PEPPER=${KEY_PEPPER}|" \
  -e "s|^JWT_SECRET=.*|JWT_SECRET=${JWT_SECRET}|" \
  -e "s|^INTERNAL_TOKEN=.*|INTERNAL_TOKEN=${INTERNAL_TOKEN}|" \
  -e "s|^DASHBOARD_ORIGIN=.*|DASHBOARD_ORIGIN=https://app.${DOMAIN}|" \
  -e "s|^SMTP_FROM=.*|SMTP_FROM=\"DiRouter <noreply@${DOMAIN}>\"|" \
  .env.example > .env

echo ".env ساخته شد (دسترسی 600) / .env created"

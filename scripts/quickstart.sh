#!/usr/bin/env sh
# One-command local trial: secrets, the full stack against the mock provider, seed data, and a
# first request through the gateway. Development only; never point this at production.
# Usage: ./scripts/quickstart.sh        (or: make quickstart)
set -eu

cd "$(dirname "$0")/.."

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "Docker is required: https://docs.docker.com/get-docker/"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (docker compose ...)"
docker info >/dev/null 2>&1 || die "the Docker daemon is not running"
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v openssl >/dev/null 2>&1 || die "openssl is required"

DEV="docker compose -f compose.yaml -f compose.dev.yaml"

# Ports 80 and 443 belong to Traefik. Fail early with a clear message instead of a half-started stack.
if ! $DEV ps --status running --services 2>/dev/null | grep -qx traefik; then
  for port in 80 443; do
    if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null || nc -z 127.0.0.1 "$port" 2>/dev/null; then
      die "port $port is already in use; stop whatever is listening on it and run again"
    fi
  done
fi

if [ -f .env ]; then
  case "$(grep -E '^NODE_ENV=' .env | cut -d= -f2)" in
    production) die ".env is a production configuration; quickstart is for local trials only" ;;
  esac
  say "Using the existing .env"
else
  say "Creating .env with random secrets"
  ./scripts/bootstrap.sh
fi

say "Building and starting the stack (the first run builds the dev image and takes a few minutes)"
$DEV up -d --build --wait

say "Seeding a demo organization, models, a fallback alias and a development key"
$DEV exec -T control-api pnpm --silent --filter @dirouter/control-api seed

say "First request through the gateway"
KEY='dr-dev-local-0000000000000000'
i=0
until curl -fsS -o /dev/null http://api.localhost/healthz 2>/dev/null; do
  i=$((i + 1))
  [ "$i" -lt 30 ] || die "the gateway did not become healthy; see: $DEV logs gateway"
  sleep 1
done
curl -fsS -D - -o /dev/null http://api.localhost/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4.1","messages":[{"role":"user","content":"Hello"}]}' |
  grep -iE '^(HTTP|x-dirouter-(provider|model|attempts))' || die "the first request failed"

cat <<EOF

DiRouter is running.
  Gateway (OpenAI/Anthropic compatible)  http://api.localhost/v1   key: $KEY
  Dashboard                              http://app.localhost
  Dashboard login                        admin@dirouter.local, password in .data/seed-admin.env

"gpt-4.1" is a seeded alias whose first target always fails, so the answer above came from the
fallback. Stop with: make down    Remove everything, data included: make clean
EOF

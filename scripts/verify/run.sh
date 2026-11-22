#!/bin/sh
# Verification runner: executes checks on the host (macOS) and writes a log
# under .verify/ so results can be reviewed without terminal access.
# Usage: ./scripts/verify/run.sh [label]      e.g. ./scripts/verify/run.sh baseline
# Skip steps with SKIP="lint e2e" ./scripts/verify/run.sh
cd "$(dirname "$0")/../.." || exit 1
LABEL="${1:-baseline}"
mkdir -p .verify
LOG=".verify/${LABEL}-$(date +%Y%m%d-%H%M%S).log"
SUMMARY=".verify/${LABEL}-latest.summary"
: > "$SUMMARY"
DEV="docker compose -f compose.yaml -f compose.dev.yaml"

step() {
  name="$1"; shift
  case " $SKIP " in *" $name "*) echo "SKIP $name" | tee -a "$SUMMARY"; return;; esac
  echo "" >> "$LOG"; echo "===== STEP $name: $* =====" >> "$LOG"
  printf '%s ... ' "$name"
  start=$(date +%s)
  sh -c "$*" >> "$LOG" 2>&1
  code=$?
  dur=$(( $(date +%s) - start ))
  echo "===== END $name exit=$code ${dur}s =====" >> "$LOG"
  if [ "$code" -eq 0 ]; then echo "PASS (${dur}s)"; else echo "FAIL exit=$code (${dur}s)"; fi
  echo "$name exit=$code ${dur}s" >> "$SUMMARY"
}

{
  echo "label=$LABEL date=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "git=$(git rev-parse --short HEAD) branch=$(git rev-parse --abbrev-ref HEAD) dirty=$(git status --short | wc -l | tr -d ' ')"
  echo "node=$(node -v 2>&1) pnpm=$(pnpm -v 2>&1) docker=$(docker --version 2>&1)"
} | tee -a "$LOG" "$SUMMARY"

step install      "pnpm install --frozen-lockfile"
step db-generate  "pnpm --filter @dirouter/db exec prisma generate"
# New control-api endpoints: refresh openapi.json and the dashboard's generated client first.
step api-generate "pnpm --filter @dirouter/control-api openapi:export && pnpm --filter @dirouter/dashboard api:generate"
step typecheck    "pnpm typecheck"
step lint         "pnpm lint"
step unit         "pnpm test:unit"
step format       "pnpm format:check"
step env-docs     "node scripts/ci/check-env-docs.mjs"
step compose-up   "$DEV up -d --wait"
step migrate      "set -a && . ./.env && set +a && pnpm --filter @dirouter/db exec prisma migrate deploy"
step compose-ps   "$DEV ps"
step integration  "pnpm test:integration"
step seed         "make seed"
step e2e          "node scripts/e2e/sprint-1.mjs && node scripts/e2e/sprint-2.mjs"
# Stops PostgreSQL and Valkey on purpose; only runs when asked: CHAOS=1 ./scripts/verify/run.sh
if [ "${CHAOS:-0}" = "1" ]; then step chaos "node scripts/chaos/run.mjs"; fi
step compose-logs "$DEV logs --no-color --tail=150 gateway control-api worker"

echo "log=$LOG" | tee -a "$SUMMARY"
echo "Done. Summary: $SUMMARY"

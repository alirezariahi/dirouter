[English](README.md) · [فارسی](README.fa.md)

# DiRouter — Quick Start

> Every document is bilingual: an English `.md` file and a Persian `.fa.md` file sit side by side, and detailed guides live in `code/docs/`. See [CONTRIBUTING.md](../CONTRIBUTING.md) for the [documentation policy](../CONTRIBUTING.md#documentation-policy).

DiRouter is a resilient LLM gateway: an endpoint compatible with OpenAI and Anthropic, failover between providers and credentials, circuit breaker, rate limiting, budgets, and usage accounting. The Gateway does not connect to PostgreSQL on the hot request path, and it keeps serving with the last snapshot when the Control API is unavailable.

```text
Client ──HTTPS──▶ Traefik ──▶ Gateway ──▶ Provider / credential / fallback
                         │         │
Dashboard ──▶ Control API─┘         └─▶ Valkey ──▶ Worker ──▶ PostgreSQL
```

## 1. Local run with Docker

Prerequisites: Docker Engine + Docker Compose, OpenSSL and `curl`; ports 80 and 443 must be free. This path is for development and mocks, not production.

```bash
cd code
./scripts/bootstrap.sh
docker compose -f compose.yaml -f compose.dev.yaml up -d --build --wait
make seed
```

- `bootstrap.sh` creates a secure `.env` with random secrets. Do not use `--force` on an existing installation: overwriting the keyring/pepper can break existing credentials and current keys.
- The first build may take several minutes. `--wait` waits until the health checks are ready.
- `make seed` creates test data, mock providers, a model, an alias, and a development key. Do not run seed in production.

| Service            | Address                        |
| ------------------ | ------------------------------ |
| Dashboard          | http://app.localhost           |
| Gateway health     | http://api.localhost/healthz   |
| Control API health | http://admin.localhost/healthz |
| Mailpit (dev)      | http://localhost:58025         |

To sign in to the seeded environment use `admin@dirouter.local`; the password is in `.data/seed-admin.env`. This local file is git-ignored and must not be copied into documents or tickets.

## 2. First response

```bash
export DIROUTER_KEY='dr-dev-local-0000000000000000'  # development mock only
curl -fsS http://api.localhost/v1/chat/completions \
  -H "Authorization: Bearer $DIROUTER_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4.1","messages":[{"role":"user","content":"Hello"}]}'
```

You get a Chat Completion response from the mock. In the seed, the `gpt-4.1` alias first tries a broken provider and then a healthy one, which means failover is really in the request path. For a direct path, send the model `mock/small`.

Health and attribution checks:

```bash
curl -fsS http://api.localhost/healthz
curl -fsS http://admin.localhost/healthz
curl -sS -D - -o /dev/null http://api.localhost/v1/chat/completions \
  -H "Authorization: Bearer $DIROUTER_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"mock/small","messages":[{"role":"user","content":"Hello"}]}'
# HTTP 200; header X-Dirouter-Provider: mock and X-Request-Id for tracing
```

## 3. Building the real path

1. On a fresh installation open `http://app.localhost/setup` and create the organization and OWNER; the provider step is optional. On a seeded installation, sign in.
2. **Providers:** choose a preset or a compatible type, enter the Base URL and the real credential, and press **Test**. **Discover models** suggests the available models.
3. **Models and Combo:** register the model with the correct price and context. For failover, build a Combo with `priority` ordering and the allowed error classes, and if needed define a stable alias for clients.
4. **Organization:** create a project; **virtual keys:** create the project key with allowed models, RPM/TPM, concurrency, IP allowlist, expiry, and budget.
5. The full key is shown only once. Store it in a secret manager and use the same model/alias name in your requests.
6. Test production with `https://api.example.com/v1` and your own domain; the seed or local HTTP is not a production pattern. Read the [deployment guide](deploy-production.md) in full.

Guide to all pages, concepts, and scenarios: [user-guide](user-guide/README.md). Common errors and operational responses: [runbook](runbook.md).

## 4. Direct development with pnpm

Node.js 22 LTS and pnpm 10 are required; `corepack enable` activates the pinned version from `packageManager`. `.env`, PostgreSQL, and Valkey must be prepared separately. For a complete, low-friction start, running Docker is the main path.

```bash
corepack enable
pnpm install
pnpm build
pnpm dev
```

| App           | Default address                                  |
| ------------- | ------------------------------------------------ |
| gateway       | http://localhost:8080/healthz                    |
| control-api   | http://localhost:3000/healthz                    |
| mock-provider | http://localhost:8090/healthz                    |
| dashboard     | http://localhost:5173                            |
| website       | http://localhost:5174                            |
| worker        | no public HTTP; queue processing and log writing |

To run a single app: `pnpm --filter @dirouter/gateway dev`. Website guide: [../apps/website/README.md](../apps/website/README.md).

## 5. Daily commands

| Command                                                                                         | Task                                       |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `pnpm build`                                                                                    | build all apps and packages with Turborepo |
| `pnpm dev`                                                                                      | watch all apps                             |
| `pnpm test`                                                                                     | Vitest tests                               |
| `pnpm lint`                                                                                     | ESLint                                     |
| `pnpm typecheck`                                                                                | TypeScript check                           |
| `pnpm format` / `pnpm format:check`                                                             | Prettier formatting / check                |
| `docker compose -f compose.yaml -f compose.dev.yaml ps`                                         | service status                             |
| `docker compose -f compose.yaml -f compose.dev.yaml logs --tail=100 gateway control-api worker` | service logs                               |

CI runs lint, typecheck, test, and build for the changed packages and their consumers; integration runs with PostgreSQL and Valkey, and image publishing happens on main and on version tags. Details: [ci.md](ci.md).

## Next documents

- [Documentation index](DOCUMENTATION.md) and [contribution guide](CONTRIBUTING.md)
- [Production deployment](deploy-production.md) and [env reference](env-reference.md)
- [Operational runbook](runbook.md), [observability](observability.md), and [usage pipeline](usage-pipeline.md)
- [Seed data](seed.md), [routing](concepts/routing.md), and [limits](concepts/limits.md)

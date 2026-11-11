[English](#english) · [فارسی](#persian)

<a id="english"></a>

# DiRouter — Quick Start

> All documentation in this repository is bilingual (English and Persian), and detailed guides live in code/docs/. See [CONTRIBUTING.md](../CONTRIBUTING.md).

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

---

<a id="persian"></a>

# DiRouter — شروع سریع

> تمام مستندات این مخزن دوزبانه (انگلیسی و فارسی) است و راهنماهای تفصیلی در code/docs/ نگهداری می‌شوند. برای مشارکت به [CONTRIBUTING.md](../CONTRIBUTING.md) مراجعه کنید.

DiRouter گیت‌وی تاب‌آور LLM است: endpoint سازگار با OpenAI و Anthropic، فال‌بک بین provider و credential، circuit breaker، rate limit، بودجه و حسابداری مصرف. Gateway برای مسیر داغ درخواست به PostgreSQL وصل نمی‌شود و هنگام قطعی Control API با آخرین snapshot ادامه می‌دهد.

```text
Client ──HTTPS──▶ Traefik ──▶ Gateway ──▶ Provider / credential / fallback
                         │         │
Dashboard ──▶ Control API─┘         └─▶ Valkey ──▶ Worker ──▶ PostgreSQL
```

## ۱. اجرای محلی با Docker

پیش‌نیاز: Docker Engine + Docker Compose، OpenSSL و `curl`؛ پورت‌های 80 و 443 آزاد. این مسیر برای توسعه و mock است، نه production.

```bash
cd code
./scripts/bootstrap.sh
docker compose -f compose.yaml -f compose.dev.yaml up -d --build --wait
make seed
```

- `bootstrap.sh` یک `.env` امن با رازهای تصادفی می‌سازد. روی نصب موجود `--force` نزنید: بازنویسی keyring/pepper می‌تواند credential و کلیدهای فعلی را از کار بیندازد.
- اولین build ممکن است چند دقیقه طول بکشد. `--wait` تا آماده‌شدن health checkها صبر می‌کند.
- `make seed` دادهٔ آزمایشی، providerهای mock، مدل، alias و کلید توسعه می‌سازد. seed را در production اجرا نکنید.

| سرویس              | آدرس                           |
| ------------------ | ------------------------------ |
| داشبورد            | http://app.localhost           |
| Gateway health     | http://api.localhost/healthz   |
| Control API health | http://admin.localhost/healthz |
| Mailpit توسعه      | http://localhost:58025         |

برای ورود به محیط seed شده: `admin@dirouter.local`؛ رمز در `.data/seed-admin.env` است. این فایل محلی و git-ignored است و نباید در اسناد یا ticket کپی شود.

## ۲. اولین پاسخ

```bash
export DIROUTER_KEY='dr-dev-local-0000000000000000'  # فقط mock توسعه
curl -fsS http://api.localhost/v1/chat/completions \
  -H "Authorization: Bearer $DIROUTER_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4.1","messages":[{"role":"user","content":"Hello"}]}'
```

پاسخ Chat Completion از mock می‌گیرید. alias `gpt-4.1` در seed اول provider خراب و سپس provider سالم را امتحان می‌کند؛ این یعنی فال‌بک واقعاً در مسیر درخواست است. برای یک مسیر مستقیم، مدل `mock/small` را بفرستید.

بررسی سلامت و attribution:

```bash
curl -fsS http://api.localhost/healthz
curl -fsS http://admin.localhost/healthz
curl -sS -D - -o /dev/null http://api.localhost/v1/chat/completions \
  -H "Authorization: Bearer $DIROUTER_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"mock/small","messages":[{"role":"user","content":"Hello"}]}'
# HTTP 200؛ هدر X-Dirouter-Provider: mock و X-Request-Id برای ردیابی
```

## ۳. ساخت مسیر واقعی

1. در نصب خالی `http://app.localhost/setup` را باز کنید و سازمان/OWNER را بسازید؛ مرحلهٔ provider اختیاری است. در نصب seed شده login کنید.
2. **Providerها:** preset یا نوع سازگار را انتخاب، Base URL و credential واقعی را وارد و **تست** بزنید. **کشف مدل‌ها** مدلهای موجود را پیشنهاد می‌دهد.
3. **مدل‌ها و Combo:** مدل را با قیمت/context درست ثبت کنید. برای فال‌بک، Combo با ترتیب `priority` و کلاسهای خطای مجاز بسازید و در صورت نیاز alias ثابت برای کلاینت تعریف کنید.
4. **سازمان:** پروژه بسازید؛ **کلیدهای مجازی:** کلید پروژه را با مدلهای مجاز، RPM/TPM، همزمانی، IP allowlist، انقضا و بودجه بسازید.
5. کلید کامل فقط یک بار دیده می‌شود. آن را در secret manager قرار دهید و از همان نام model/alias در درخواست استفاده کنید.
6. production را با `https://api.example.com/v1` و دامنهٔ خود تست کنید؛ seed یا HTTP محلی الگوی production نیست. [راهنمای استقرار](deploy-production.md) را کامل بخوانید.

راهنمای همهٔ صفحه‌ها، مفاهیم و سناریوها: [user-guide](user-guide/README.md). خطاهای رایج و واکنش عملیاتی: [runbook](runbook.md).

## ۴. توسعهٔ مستقیم با pnpm

Node.js 22 LTS و pnpm 10 لازم است؛ `corepack enable` نسخهٔ pinned را از `packageManager` فعال می‌کند. `.env`، PostgreSQL و Valkey باید جدا آماده باشند. برای شروع کامل و کم‌اصطکاک، Docker بالا مسیر اصلی است.

```bash
corepack enable
pnpm install
pnpm build
pnpm dev
```

| اپ            | آدرس پیش‌فرض                           |
| ------------- | -------------------------------------- |
| gateway       | http://localhost:8080/healthz          |
| control-api   | http://localhost:3000/healthz          |
| mock-provider | http://localhost:8090/healthz          |
| dashboard     | http://localhost:5173                  |
| website       | http://localhost:5174                  |
| worker        | بدون HTTP عمومی؛ پردازش صف و نوشتن لاگ |

دستور روی یک اپ: `pnpm --filter @dirouter/gateway dev`. راهنمای وب‌سایت: [../apps/website/README.md](../apps/website/README.md).

## ۵. دستورهای روزمره

| دستور                                                                                           | کار                                     |
| ----------------------------------------------------------------------------------------------- | --------------------------------------- |
| `pnpm build`                                                                                    | build همهٔ اپ‌ها و پکیج‌ها با Turborepo |
| `pnpm dev`                                                                                      | watch همهٔ اپ‌ها                        |
| `pnpm test`                                                                                     | تست‌های Vitest                          |
| `pnpm lint`                                                                                     | ESLint                                  |
| `pnpm typecheck`                                                                                | بررسی TypeScript                        |
| `pnpm format` / `pnpm format:check`                                                             | قالب‌بندی / بررسی Prettier              |
| `docker compose -f compose.yaml -f compose.dev.yaml ps`                                         | وضعیت سرویسها                           |
| `docker compose -f compose.yaml -f compose.dev.yaml logs --tail=100 gateway control-api worker` | لاگ سرویسها                             |

CI تغییرات و مصرف‌کنندگانشان را lint، typecheck، test و build می‌کند؛ integration با PostgreSQL و Valkey دارد و انتشار image روی main/tag نسخه انجام می‌شود. جزئیات: [ci.md](ci.md).

## مستندات بعدی

- [فهرست مستندات](DOCUMENTATION.md) و [راهنمای مشارکت](CONTRIBUTING.md)
- [استقرار production](deploy-production.md) و [مرجع env](env-reference.md)
- [Runbook عملیاتی](runbook.md)، [مشاهده‌پذیری](observability.md) و [usage pipeline](usage-pipeline.md)
- [دادهٔ seed](seed.md)، [مسیریابی](concepts/routing.md) و [محدودیتها](concepts/limits.md)

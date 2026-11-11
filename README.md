> راهنمای کامل فارسی و محلی: [docs/README.md](docs/README.md) · مستندات فارسی بیرون مخزن Git نگهداری می‌شوند.

# DiRouter

DiRouter یک گیت‌وی تاب‌آور برای LLM است: endpoint سازگار با OpenAI و Anthropic، فال‌بک بین provider و credential، circuit breaker، rate limit، بودجه و حسابداری مصرف. مسیر درخواست از دیتابیس جداست و در قطعی Control API با آخرین snapshot کار می‌کند.

```text
Client ──HTTPS──▶ Traefik ──▶ Gateway ──▶ Provider / credential / fallback
                         │         │
Dashboard ──▶ Control API─┘         └─▶ Valkey ──▶ Worker ──▶ PostgreSQL
```

## شروع سریع با Docker (توسعهٔ محلی)

**زمان تقریبی راه‌اندازی:** چند دقیقه، بسته به دانلود image و build اولیه. این مسیر با provider ساختگی اجرا می‌شود و برای production نیست.

پیش‌نیازها: Docker Engine با Docker Compose، `curl` و OpenSSL. پورت‌های 80 و 443 باید آزاد باشند.

```bash
cd code
./scripts/bootstrap.sh
docker compose -f compose.yaml -f compose.dev.yaml up -d --build --wait
make seed
```

`bootstrap.sh` فایل `.env` با رازهای تصادفی و مجوز 600 می‌سازد. اگر `.env` وجود دارد، آن را بازنویسی نمی‌کند؛ روی نصب موجود `--force` نزنید. `make seed` سازمان، مدل، alias و کلیدهای **توسعه** می‌سازد و providerها را به mock وصل می‌کند.

آدرس‌ها:

| سرویس              | آدرس                           |
| ------------------ | ------------------------------ |
| داشبورد            | http://app.localhost           |
| Gateway health     | http://api.localhost/healthz   |
| Control API health | http://admin.localhost/healthz |
| ایمیل توسعه        | http://localhost:58025         |

ورود اختیاری به داشبورد: ایمیل `admin@dirouter.local` و رمز تولیدشده در `.data/seed-admin.env` (فایل محلی، git-ignored و با مجوز 600).

### اولین درخواست

کلید زیر صرفاً کلید ثابت **mock توسعه** است؛ در production کلید یک‌بارنمایش خودتان را بسازید:

```bash
export DIROUTER_KEY='dr-dev-local-0000000000000000'
curl -fsS http://api.localhost/v1/chat/completions \
  -H "Authorization: Bearer $DIROUTER_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-4.1",
    "messages": [{"role":"user","content":"Hello"}]
  }'
```

پاسخ موفق یک Chat Completion از mock است. در دادهٔ seed، alias `gpt-4.1` ابتدا `mock/down` را امتحان و سپس به `mock/small` فال‌بک می‌دهد؛ بنابراین مقدار `X-Dirouter-Attempts` می‌تواند بیشتر از یک باشد. برای بررسی provider واقعی پاسخ:

```bash
curl -sS -D - -o /dev/null http://api.localhost/v1/chat/completions \
  -H "Authorization: Bearer $DIROUTER_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"mock/small","messages":[{"role":"user","content":"Hello"}]}'
# انتظار: HTTP 200 و X-Dirouter-Provider: mock
```

### اتصال provider واقعی و ساخت کلید production-like

1. وارد داشبورد شوید؛ در نصب کاملاً خالی، `/setup` سازمان، OWNER، provider اختیاری و اولین کلید را می‌سازد. در محیط seed شده به جای setup از login استفاده کنید.
2. در **Providerها** نوع و Base URL را انتخاب و credential واقعی را وارد کنید. با **تست** اتصال و با **کشف مدل‌ها** مدل‌های upstream را ببینید.
3. در **مدل‌ها و Combo** مدل را بسازید یا از کشف اضافه کنید؛ قیمت و context را کنترل کنید. در صورت نیاز Combo و alias بسازید.
4. در **سازمان** پروژه بسازید؛ سپس در **کلیدهای مجازی** کلید را به پروژه وصل و مدلهای مجاز، RPM/TPM، همزمانی، انقضا و بودجه را محدود کنید.
5. کلید کامل فقط یک بار نمایش داده می‌شود. آن را در مدیر راز بگذارید و در URL، Git یا لاگ وارد نکنید.
6. نام مدل/alias ساخته‌شده و endpoint واقعی (`https://api.example.com/v1`) را با همان curl بالا امتحان کنید؛ `localhost` را با دامنهٔ خود عوض کنید.

جزئیات صفحه‌ها و سناریوهای «اول اشتراک و بعد API ارزان» و «فال‌بک بین چند credential» در [راهنمای کاربر داشبورد](docs/user-guide/README.md) است.

## اجرای مستقیم برای توسعه

اگر به hot reload خارج Docker نیاز دارید: Node.js 22 LTS و pnpm 10 لازم است (`corepack enable` نسخهٔ pinned را از `packageManager` می‌خواند). PostgreSQL و Valkey و متغیرهای `.env` نیز باید در دسترس باشند؛ برای راه‌اندازی کامل‌تر از مسیر Docker بالا استفاده کنید.

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

## دستورها

| دستور                               | کار                                        |
| ----------------------------------- | ------------------------------------------ |
| `pnpm build`                        | build همهٔ اپ‌ها و پکیج‌ها با کش Turborepo |
| `pnpm dev`                          | اجرای اپ‌ها در حالت watch                  |
| `pnpm test`                         | تست‌های Vitest                             |
| `pnpm lint`                         | ESLint روی workspace                       |
| `pnpm typecheck`                    | بررسی TypeScript                           |
| `pnpm format` / `pnpm format:check` | قالب‌بندی / بررسی Prettier                 |

برای یک اپ: `pnpm --filter @dirouter/gateway dev`. راهنمای سایت عمومی: [apps/website/README.md](apps/website/README.md).

## English summary

DiRouter exposes OpenAI- and Anthropic-compatible LLM endpoints with provider/credential fallback, circuit breakers, distributed limits, budgets, and usage accounting.

**Local Docker quick start:** install Docker Engine + Compose, then run `./scripts/bootstrap.sh`, `docker compose -f compose.yaml -f compose.dev.yaml up -d --build --wait`, and `make seed` from `code/`. Open `http://app.localhost`. The seeded development key `dr-dev-local-0000000000000000` works only with the local mock provider; send `POST http://api.localhost/v1/chat/completions` with a bearer token, model `gpt-4.1`, and a chat `messages` array. For a real deployment, create your own provider credential and one-time virtual key—never use seed data in production.

Detailed local Persian guides: [Quick Start](docs/README.md), [dashboard user guide](docs/user-guide/README.md), [production deployment](docs/deploy-production.md), and [operations runbook](docs/runbook.md).

## CI

GitHub Actions روی PRها و `main`، بسته‌های تغییرکرده و مصرف‌کنندگانشان را lint، typecheck، test و build می‌کند. integration با PostgreSQL و Valkey اجرا می‌شود و imageها پس از موفقیت بررسی‌ها روی main یا تگ نسخه در GHCR منتشر می‌شوند. جزئیات در [CI.md](CI.md).

## ساختار مخزن

```text
code/
├─ apps/
│  ├─ gateway/        Data plane درخواست LLM؛ بدون وابستگی به PostgreSQL
│  ├─ control-api/    احراز هویت، مدیریت config و انتشار snapshot
│  ├─ worker/         صف مصرف، تجمیع، retention و reconcile بودجه
│  ├─ dashboard/      داشبورد فارسی RTL (React + Vite)
│  ├─ website/        سایت عمومی فارسی و دموی مسیریابی
│  └─ mock-provider/  upstream ساختگی با تزریق خطا برای توسعه و تست
├─ packages/          contracts، shared، db، model-catalog، ui و پیکربندی مشترک
├─ deploy/            imageها و پیکربندی Traefik
└─ adr/               تصمیم‌های معماری عمومی
```

اپ‌ها می‌توانند به پکیج‌ها وابسته باشند؛ پکیج‌ها به اپ وابسته نیستند. `contracts` وابستگی داخلی ندارد و gateway به `@dirouter/db` وابسته نیست.

## مستندات و مشارکت

- [فهرست مستندات عمومی](DOCUMENTATION.md) و [قراردادهای مشارکت](CONTRIBUTING.md)
- [استقرار production](docs/deploy-production.md)، [مرجع env](docs/env-reference.md) و [Runbook](docs/runbook.md)
- [مشاهده‌پذیری](docs/observability.md)، [مسیر usage](docs/usage-pipeline.md) و [دادهٔ seed](docs/seed.md)

انگلیسی زبان canonical اسناد versioned داخل مخزن است. راهنماهای فارسی در `docs/` بیرون Git نگهداری می‌شوند و در clone یا Docker build context قرار ندارند.

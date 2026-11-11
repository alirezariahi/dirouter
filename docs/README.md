> نسخهٔ فارسی محلی؛ نسخهٔ انگلیسی خلاصه و canonical داخل مخزن: [../code/README.md](../code/README.md). این فایل بیرون Git است.

# DiRouter — شروع سریع

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

دستور روی یک اپ: `pnpm --filter @dirouter/gateway dev`. راهنمای وب‌سایت: [../code/apps/website/README.md](../code/apps/website/README.md).

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

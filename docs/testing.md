[English](#english) · [فارسی](#persian)

<a id="english"></a>

# End-to-end test — Sprint 1

The script [`scripts/e2e/sprint-1.mjs`](../scripts/e2e/sprint-1.mjs) checks the real development app through Traefik. Requests go to `api.localhost` and `mock.localhost`, and only the seed fixtures are read.

## Running

```bash
cd code
make up
make seed
make e2e              # or: pnpm test:e2e
```

Prerequisites: Node.js 22, Docker Compose and the generated seed credential in `.data/seed-admin.env`. The script logs in to control-api as the development admin user and creates three temporary keys with restricted models. No existing provider, model or key is changed. At the end, the temporary keys are revoked and the stopped services are started again.

> This test intentionally stops and restarts `control-api` and `valkey`; do not run it on production or a shared environment. The gateway and the mock must be running during the test.

## Scenarios

- An Anthropic `/v1/messages` input is translated to a provider of the OpenAI-compatible type; the Anthropic response shape and the body received by the mock are checked.
- A 503 from the primary provider of combo `dev` falls back to a healthy target; observing the 503 and a successful request in the mock is required.
- A 429 in combo `dev-429` only puts `cred_mock-429` into cooldown; the next request passes through the healthy Anthropic provider without retrying that credential.
- A temporary key with a one-token budget gets `billing_error` after a 429 is consumed; an independent key with `rpm=1` rejects the second request with a 429 `rate_limit_error` and the retry/rate-limit headers.
- When control-api is stopped, the gateway keeps responding with the stored snapshot; after it starts, sync becomes healthy again.
- When Valkey is stopped, the successful response stays and the usage is stored in the local outbox; after recovery, exactly one row in `request_log` and one row in `usage_ledger` are created with the same request ID.

The default URLs can be overridden with `E2E_GATEWAY_URL`, `E2E_ADMIN_URL` and `E2E_MOCK_URL`. The service names and the current development database (`org_dev`, `prj_dev`, `dirouter`) are test fixtures.

CI does not run this destructive test on every push. For CI, a dedicated one-time Compose environment must be created and seeded, and then this same command run. The unit/integration tests that do not stop dev services remain in the existing pipeline.

## Local run result

On 8 November 2026 all six scenarios passed on the real dev environment. Gateway and control-api health, and the healthy state of Valkey and the rest, were also checked after cleanup. The temporary keys were revoked. The usage and audit records created by the requests remain, as is normal system behavior.

---

<a id="persian"></a>

# تست end-to-end — اسپرینت ۱

اسکریپت [`scripts/e2e/sprint-1.mjs`](../scripts/e2e/sprint-1.mjs) اپ واقعیِ development را از طریق Traefik بررسی می‌کند؛ درخواست‌ها به `api.localhost` و `mock.localhost` می‌روند و فقط fixtureهای seed خوانده می‌شوند.

## اجرا

```bash
cd code
make up
make seed
make e2e              # یا: pnpm test:e2e
```

پیش‌نیازها: Node.js 22، Docker Compose و credential تولیدشدهٔ seed در `.data/seed-admin.env`. اسکریپت با کاربر admin توسعه وارد control-api می‌شود و سه کلید موقت با مدلهای محدود می‌سازد. هیچ provider، مدل یا کلید موجودی تغییر نمی‌کند. در پایان کلیدهای موقت revoke و سرویسهای متوقف‌شده start می‌شوند.

> این تست عمداً `control-api` و `valkey` را متوقف و دوباره راه‌اندازی می‌کند؛ آن را روی production یا محیط مشترک اجرا نکنید. در طول تست gateway و mock باید در حال کار باشند.

## سناریوها

- ورودی Anthropic `/v1/messages` به provider نوع OpenAI-compatible ترجمه می‌شود؛ شکل پاسخ Anthropic و بدنهٔ دریافتی mock بررسی می‌شود.
- خطای ۵۰۳ provider اولیه combo `dev` به target سالم فال‌بک می‌کند؛ مشاهدهٔ ۵۰۳ و درخواست موفق در mock الزامی است.
- خطای ۴۲۹ در combo `dev-429` فقط `cred_mock-429` را cooldown می‌کند؛ درخواست بعدی بدون retry آن credential از Anthropic provider سالم عبور می‌کند.
- کلید موقت با بودجهٔ یک توکن پس از مصرف ۴۲۹ `billing_error` می‌گیرد؛ کلید مستقل با `rpm=1` درخواست دوم را با ۴۲۹ `rate_limit_error` و هدرهای retry/rate-limit رد می‌کند.
- با توقف control-api، gateway با snapshot ذخیره‌شده به پاسخ ادامه می‌دهد و پس از start، sync سالم می‌شود.
- با توقف Valkey، پاسخ موفق می‌ماند و usage در outbox محلی ذخیره می‌شود؛ پس از recovery دقیقاً یک ردیف در `request_log` و یک ردیف در `usage_ledger` با همان request ID ساخته می‌شود.

URLهای پیش‌فرض با `E2E_GATEWAY_URL`، `E2E_ADMIN_URL` و `E2E_MOCK_URL` قابل override هستند. نام سرویسها و دیتابیس development فعلی (`org_dev`، `prj_dev`، `dirouter`) fixture آزمون‌اند.

CI روی هر push این تست مخرب را اجرا نمی‌کند؛ برای CI لازم است یک محیط Compose یک‌بارمصرف اختصاصی ساخته و seed شود، سپس همین فرمان اجرا شود. تستهای unit/integration بدون توقف سرویسهای dev در پایپلاین موجود باقی می‌مانند.

## نتیجهٔ اجرای محلی

در ۸ نوامبر ۲۰۲۶ هر شش سناریو روی محیط dev واقعی سبز شدند؛ سلامت gateway و control-api و وضعیت healthy والکی پس از cleanup نیز بررسی شد. کلیدهای موقت revoke شده‌اند. رکوردهای usage و audit حاصل از درخواستها، مطابق رفتار عادی سیستم، باقی می‌مانند.

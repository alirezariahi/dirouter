[English](testing.fa.md) · [فارسی](testing.fa.md)

<div dir="rtl">

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

</div>

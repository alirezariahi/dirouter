[English](DOCUMENTATION.md) · [فارسی](DOCUMENTATION.fa.md)

<div dir="rtl">

# راهنمای مستندات محلی

هر سند در دو فایل نگهداری می‌شود: یک فایل انگلیسی با پسوند `.md` و یک فایل فارسی با پسوند `.fa.md`. راهنماهای تفصیلی در `code/docs/` قرار دارند. [سیاست مستندات](../CONTRIBUTING.fa.md#documentation-policy-fa) را ببینید.

- [README](../README.fa.md) — [نسخهٔ انگلیسی](../README.fa.md)
- [راهنمای کاربر داشبورد و مفاهیم](user-guide/README.fa.md) — همهٔ صفحه‌ها، سناریوهای رایج و اسکرین‌شات محلی
- [راهنمای قابلیت‌های اسپرینت ۲](sprint-2.fa.md) — مسیریابی، کش، امنیت، guardrail، هشدار، tracing و HA؛ چه چیزی تأیید شده و چه چیزی نه
- [Runbook عملیاتی](runbook.fa.md) — علائم، تشخیص، اقدام و بررسی برای حادثه‌های سرویس
- [راهنمای مشارکت](../CONTRIBUTING.fa.md) — [نسخهٔ انگلیسی](../CONTRIBUTING.fa.md)
- [معماری](architecture.fa.md) — [نسخهٔ انگلیسی](architecture.fa.md)
- [واژه‌نامه](glossary.fa.md) — [نسخهٔ انگلیسی](glossary.fa.md)
- [راهنمای CI](ci.fa.md) — [نسخهٔ انگلیسی](ci.fa.md)
- [ADRها](adr/README.fa.md) — [نسخهٔ انگلیسی](adr/README.fa.md)
- [تحقیق رقبا](research/feature-comparison.fa.md) — [نسخهٔ انگلیسی](research/feature-comparison.fa.md)؛ یک نسخهٔ محلی هم در [en/research](en/research/feature-comparison.fa.md) هست
- [برنامهٔ اسپرینت‌ها](board/README.fa.md) — [نسخهٔ انگلیسی](board/README.fa.md)؛ یک نسخهٔ محلی هم در [en/board](en/board/README.fa.md) هست
- [یادداشت بررسی محلی CI](en/ci-verification.fa.md)

اطلاعات ورود برد در `board/dirouter-board.json` و اسکریپت‌های سازنده در `tools/board/` قرار دارند و محلی هستند. نسخهٔ واردشدنی برد یک snapshot قدیمی است؛ وضعیت فعلی کار از برد زنده خوانده می‌شود.

## سایت مستندات

`apps/docs` پوشه‌های `docs/` و `adr/` را به‌صورت یک سایت قابل جستجو (Astro Starlight) منتشر می‌کند: انگلیسی در `/` و فارسی (راست‌به‌چپ) در `/fa/` (کارت ۲۲.۵). هیچ چیز دستی کپی نمی‌شود:

- `scripts/sync.mjs` هر جفت `name.md` و `name.fa.md` را به دو صفحهٔ یک سند تبدیل می‌کند. H1 عنوان صفحه می‌شود، خط تعویض زبان حذف می‌شود، لینک‌های بین اسناد به لینک‌های سایت و لینک‌های دیگر فایل‌های مخزن به گیت‌هاب تبدیل می‌شوند. `adr/` زیر `/decisions/` می‌آید.
- مرجع API (`/api/reference/`) از `apps/dashboard/openapi.json` ساخته می‌شود.
- build با یک بررسی لینک تمام می‌شود: هر سند باید صفحهٔ خود را داشته باشد و هیچ صفحه‌ای نباید به صفحهٔ ناموجود لینک بدهد. CI هر وقت `docs/`، `adr/` یا `apps/docs` تغییر کند آن را اجرا می‌کند.
- اجرای محلی با `pnpm --filter @dirouter/docs dev`؛ استقرار با `docker compose --profile docs up -d docs` که پشت Traefik در `docs.<DOMAIN>` سرو می‌شود.

</div>

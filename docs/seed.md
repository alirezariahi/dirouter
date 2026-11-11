# Seed و داده‌های نمونه

کد: `apps/control-api/src/seed.ts` · کارت ۳.۱۱

```bash
make up
make seed
```

`make seed` در کانتینر control-api اجرا می‌شود و این‌ها را در DB می‌سازد، idempotent و با شناسه‌های ثابت:

| چیز                            | مقدار                                                                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| سازمان                         | `DiRouter Dev` (`org_dev`)                                                                                                                                                            |
| مدیر                           | `admin@dirouter.local` با نقش OWNER. رمزش فقط بار اول ساخته و در `.data/seed-admin.env` (git-ignored، 600) نوشته می‌شود. با `SEED_ADMIN_PASSWORD` قابل تعیین است.                     |
| providerها (روی mock-provider) | `mock`، `mock-down` (503)، `mock-bad` (400)، `mock-429`، `mock-tool`، `mock-nousage`، `mock-anthropic`، `mock-azure`، `mock-long` (stream ده‌دقیقه‌ای)                                |
| مدل‌ها                         | `mock/small`، `mock/down`، `mock/bad`، `mock/429`، `mock/tool`، `mock/nousage`، `mock/claude`، `mock/azure`، `mock/long` (context ۲۰۰K)                                               |
| combo                          | `dev` (down، سپس small)، `dev-bad` (bad، سپس small؛ نباید فال‌بک بدهد)، `dev-429` (429، سپس claude)                                                                                   |
| alias                          | `gpt-4.1` به combo `dev`؛ `claude-sonnet-4-5` به `mock/claude`؛ `claude-haiku-4-5` به `mock/tool` (برای Claude Code)                                                                  |
| پروژه                          | `Dev` (`prj_dev`)                                                                                                                                                                     |
| کلیدها                         | `dr-dev-local-0000000000000000` (همه‌چیز)، `dr-dev-limited-000000000000` (فقط `mock/small`)، `dr-dev-expired-000000000000` (منقضی)، `dr-dev-ipallow-000000000000` (فقط `203.0.113.7`) |

- در پایان، پیام `dirouter:config:rebuild` منتشر می‌شود. control-api snapshot تازه را می‌سازد و گیت‌وی بی‌درنگ آن را می‌گیرد. control-api در هر صورت هر ۳۰ ثانیه هم بررسی می‌کند.
- **production**: هم Makefile (`NODE_ENV=production` در `.env`) و هم خود اسکریپت (`NODE_ENV` باید `development` باشد) اجرا را رد می‌کنند، با خروجی ۱.
- `make dev-snapshot` فقط برای اجرای گیت‌وی بدون control-api است. snapshot آزمایشی را روی دیسک گیت‌وی می‌نویسد.

بررسی (۲۰۲۶-۱۱-۰۷):

- بعد از `make seed`، با کلید dev: `gpt-4.1` و `mock/small` و `claude-sonnet-4-5` پاسخ 200 دادند و `dev-bad` پاسخ 400 داد (بدون فال‌بک).
- کلید محدود روی `mock/claude` پاسخ 403 و کلید منقضی 401 گرفت.
- اجرای دوم بدون تغییر رمز بود.
- با `NODE_ENV=production` اجرا رد شد.

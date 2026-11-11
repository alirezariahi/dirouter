[English](#english) · [فارسی](#persian)

<a id="english"></a>

# Seed and sample data

Code: `apps/control-api/src/seed.ts` · Card 3.11

```bash
make up
make seed
```

`make seed` runs in the control-api container and creates the following in the DB. It is idempotent and uses fixed ids:

| Item                         | Value                                                                                                                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Organization                 | `DiRouter Dev` (`org_dev`)                                                                                                                                                                           |
| Admin                        | `admin@dirouter.local` with the OWNER role. Its password is generated only on the first run and written to `.data/seed-admin.env` (git-ignored, mode 600). It can be set with `SEED_ADMIN_PASSWORD`. |
| Providers (on mock-provider) | `mock`, `mock-down` (503), `mock-bad` (400), `mock-429`, `mock-tool`, `mock-nousage`, `mock-anthropic`, `mock-azure`, `mock-long` (ten-minute stream)                                                |
| Models                       | `mock/small`, `mock/down`, `mock/bad`, `mock/429`, `mock/tool`, `mock/nousage`, `mock/claude`, `mock/azure`, `mock/long` (context 200K)                                                              |
| Combo                        | `dev` (down, then small), `dev-bad` (bad, then small; must not fall back), `dev-429` (429, then claude)                                                                                              |
| Alias                        | `gpt-4.1` to combo `dev`; `claude-sonnet-4-5` to `mock/claude`; `claude-haiku-4-5` to `mock/tool` (for Claude Code)                                                                                  |
| Project                      | `Dev` (`prj_dev`)                                                                                                                                                                                    |
| Keys                         | `dr-dev-local-0000000000000000` (everything), `dr-dev-limited-000000000000` (only `mock/small`), `dr-dev-expired-000000000000` (expired), `dr-dev-ipallow-000000000000` (only `203.0.113.7`)         |

- At the end, the message `dirouter:config:rebuild` is published. control-api builds a fresh snapshot and the gateway picks it up immediately. In any case, control-api also checks every 30 seconds.
- **production**: both the Makefile (`NODE_ENV=production` in `.env`) and the script itself (`NODE_ENV` must be `development`) refuse to run, with exit code 1.
- `make dev-snapshot` is only for running the gateway without control-api. It writes an experimental snapshot to the gateway's disk.

Check (2026-11-07):

- After `make seed`, with the dev key: `gpt-4.1`, `mock/small` and `claude-sonnet-4-5` returned 200, and `dev-bad` returned 400 (no fallback).
- The limited key on `mock/claude` got 403 and the expired key got 401.
- The second run was without a password change.
- Running with `NODE_ENV=production` was rejected.

---

<a id="persian"></a>

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

[English](dev.md) · [فارسی](dev.fa.md)

<div dir="rtl">

# داشبورد: ساختار و قراردادها

کد: `apps/dashboard` · کارت ۷.۱

## پشته

| بخش             | انتخاب                                                              | چرا                                                                         |
| --------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| ساخت            | Vite و React 19 با TypeScript strict                                | سریع، و bundle کوچک با تقسیم مسیرها                                         |
| مسیریابی        | TanStack Router (code-based)                                        | تایپ‌دار، با preload روی hover (`defaultPreload: 'intent'`) و صفحه‌های lazy |
| داده            | TanStack Query و کلاینت orval                                       | retry نکردن خطاهای 4xx، و staleTime پانزده‌ثانیه‌ای                         |
| استایل          | Tailwind v4 (`@tailwindcss/vite`) و کامپوننت‌های ساده به سبک shadcn | بدون CSS-in-JS؛ تم با متغیرهای CSS                                          |
| فونت            | Vazirmatn Variable (`@fontsource-variable/vazirmatn`)               | فایل محلی با unicode-range، بدون CDN                                        |
| زبان            | i18next و react-i18next؛ فارسی پیش‌فرض، و انگلیسی                   |                                                                             |
| تاریخ           | `Intl.DateTimeFormat` با `-u-ca-persian` یا `gregory`               | تقویم شمسی بدون کتابخانه                                                    |
| command palette | cmdk (`⌘K` / `Ctrl+K`)                                              |                                                                             |

## ساختار پوشه

```
src/
  main.tsx            QueryClient، Settings، Router
  router.tsx          مسیرها؛ صفحه‌ها با lazyRouteComponent
  settings.tsx        تم و تقویم (context)؛ زبان با i18next
  config.ts           آدرس API: /config.js (nginx) ← VITE_API_URL ← همان origin
  i18n/               fa.ts (منبع کلیدها)، en.ts (تایپ از fa)، index.ts
  lib/
    api.ts            fetch با access token در حافظه، refresh خودکار روی 401، ApiError
    date.ts           formatDate و formatNumber
    prefs.ts          localStorage امن؛ applyLang (lang و dir) و applyTheme (کلاس dark)
    cn.ts             clsx و tailwind-merge
  components/
    ui/               Button، Card، و states (Loading، Empty، ErrorState)
    layout/           AppShell، CommandPalette، nav
  pages/              یک فایل برای هر صفحه (export پیش‌فرض برای lazy)
  api/generated.ts    خروجی orval (دستی ویرایش نشود)
openapi.json          سند control-api برای orval
```

## قراردادها

- **RTL و LTR**: فقط از logical properties استفاده کنید: `ps-*`، `pe-*`، `ms-*`، `me-*`، `start-*`، `end-*`، `border-s` و `border-e`. هرگز `left` یا `right`، و نه `pl`، `pr`، `ml` یا `mr`. sidebar با `border-e` همیشه در سمت «شروع» است: راست در فارسی و چپ در انگلیسی. تغییر زبان `lang` و `dir` روی `<html>` را عوض می‌کند (`applyLang`) و در localStorage می‌ماند.
- **متن**: هیچ رشتهٔ ثابتی در JSX نیست. کلید را اول در `fa.ts` اضافه کنید؛ `en.ts` از روی آن تایپ می‌شود و کلید جاافتاده خطای کامپایل می‌دهد.
- **رنگ**: فقط توکن‌های تم: `bg-bg`، `bg-surface`، `text-fg`، `text-muted`، `border-border`، `bg-brand`، `text-danger`. حالت تیره با `.dark` روی `<html>` است. گزینهٔ «سیستم» از `prefers-color-scheme` پیروی می‌کند.
- **حالت‌ها**: هر صفحهٔ دارای داده از `Loading`، `Empty` و `ErrorState` استفاده می‌کند. `ErrorState` پیام problem+json و `requestId` را نشان می‌دهد و دکمهٔ تلاش دوباره دارد. خطای مسیر را `errorComponent` روت می‌گیرد.
- **احراز هویت**: access token فقط در حافظه است (نه localStorage)، و refresh با کوکی httpOnly انجام می‌شود ([control-api/auth.md](../control-api/auth.fa.md)). چند 401 هم‌زمان یک refresh مشترک دارند.
- **کلاینت API**:

  ```bash
  pnpm --filter @dirouter/control-api openapi:export
  pnpm --filter @dirouter/dashboard api:generate
  ```

  بعد از هر تغییر API اجرا شود. hookهای `useXxx` تایپ‌دار تولید می‌شوند و همه از `orvalFetch` (همان refresh و ApiError) می‌گذرند.

- **کامپوننت مشترک**: کامپوننت‌های پایه فعلاً در `src/components/ui` هستند. وقتی اپ دومی (مثل website) لازمشان داشت، به `packages/ui` منتقل می‌شوند.
- **عملکرد**: هر صفحه lazy است و فونت محلی است. کتابخانهٔ تاریخ و آیکون سنگین ممنوع است. هدف Lighthouse performance حداقل ۹۰ روی build است (بخش پایین).

## اجرا

```bash
make up                                     # https://app.localhost (پشت Traefik)
pnpm --filter @dirouter/dashboard dev       # بدون Docker: http://localhost:5173 (VITE_API_URL را بدهید)
pnpm --filter @dirouter/dashboard test      # jsdom: جهت با زبان، تم، ⌘K، 404، refresh و تاریخ
pnpm --filter @dirouter/dashboard build && pnpm --filter @dirouter/dashboard preview
```

## Lighthouse (۲۰۲۶-۱۱-۰۸)

روی build (`vite preview`) با Lighthouse 12، پروفایل پیش‌فرض موبایل و throttling شبیه‌سازی‌شده، در دو اجرا:

| دسته           | امتیاز                                                   |
| -------------- | -------------------------------------------------------- |
| Performance    | **95** (FCP 2.3s، LCP 2.4s، TBT بین 0 و 10ms، CLS 0.001) |
| Accessibility  | 100                                                      |
| Best practices | 96                                                       |

اندازهٔ bundle:

- JS اولیه ۱۱۲KB (gzip).
- command palette جدا و lazy است (۱۷KB) و با اولین ⌘K بارگذاری می‌شود. این کار JS اولیه را از ۱۴۹KB به ۱۱۲KB رساند.
- فونت‌ها محلی هستند و بر اساس unicode-range بارگذاری می‌شوند (عربی ۴۶KB، لاتین ۳۵KB).

```bash
pnpm --filter @dirouter/dashboard build && pnpm --filter @dirouter/dashboard preview --port 4173
npx lighthouse http://localhost:4173/ --only-categories=performance
```

## بررسی در compose

`https://app.localhost` (یا `http://app.localhost`) پاسخ 200 داد و `<html lang="fa" dir="rtl">` بود. تغییر زبان به English جهت را `ltr` کرد و برچسب‌ها انگلیسی شدند. برگشت به فارسی دوباره `rtl` شد.

## ورود، راه‌اندازی و نشست (کارت ۷.۲)

| مسیر       | توضیح                                                                                                                                                                                                                                                                   |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/setup`   | ویزارد سه‌مرحله‌ای، فقط وقتی هنوز کاربری نیست: ۱) سازمان و حساب مالک، ۲) اولین provider (اختیاری: نوع، نام، baseUrl برای سازگار یا Azure، و کلید)، ۳) اولین کلید مجازی، که پروژهٔ «Default» را هم می‌سازد. کلید فقط یک بار با دکمهٔ کپی و آدرس گیت‌وی نشان داده می‌شود. |
| `/login`   | ایمیل و رمز                                                                                                                                                                                                                                                             |
| `/account` | تغییر رمز. بعد از آن همهٔ نشست‌ها بسته می‌شوند و کاربر به `/login` برمی‌گردد.                                                                                                                                                                                           |
| خروج       | دکمهٔ «خروج» در نوار بالا. خانوادهٔ refresh token باطل و کوکی پاک می‌شود.                                                                                                                                                                                               |

- **محافظت مسیرها**: همهٔ صفحه‌ها جز `/login` و `/setup` زیر layout محافظت‌شده‌اند. `beforeLoad` نشست را با refresh کوکی بازیابی می‌کند. در نبود نشست، اگر هنوز کاربری نیست به `/setup` می‌رود، وگرنه به `/login`.
- **تمدید خودکار توکن**: access token پانزده‌دقیقه‌ای است. هر 401 یک بار با `/auth/refresh` تکرار می‌شود (refresh مشترک بین درخواست‌های هم‌زمان). اگر refresh شکست بخورد، کاربر خارج می‌شود.
- **پیام خطا**: `lib/errors.ts` کد پایدار problem+json را به متن دقیق فارسی یا انگلیسی تبدیل می‌کند، مثلاً `invalid_credentials` و `login_locked` (همراه با زمان تقریبی)، `setup_completed`، `refresh_token_reused`، `forbidden`، `conflict`، خطای شبکه و … خطای اعتبارسنجی هر فیلد زیر همان فیلد نشان داده می‌شود.
- **آدرس API در dev**: از آدرس صفحه ساخته می‌شود (`app.` به `admin.`). پس `http://app.localhost` و `https://app.localhost` هر دو کار می‌کنند. CORS در control-api فهرست `DASHBOARD_ORIGIN` (جداشده با کاما) را می‌پذیرد.

### زمان «از نصب تا اولین کلید» (۲۰۲۶-۱۱-۰۸)

| گام                                                                | زمان                                  |
| ------------------------------------------------------------------ | ------------------------------------- |
| `make up` روی ایمیج‌های موجود                                      | ۴۳ تا ۵۱ ثانیه (اندازه‌گیری‌های قبلی) |
| بارگذاری اول داشبورد در dev (کامپایل Vite)                         | حدود ۱۴ ثانیه                         |
| ویزارد کامل (سازمان، provider، کلید)، خودکار در مرورگر روی DB خالی | ۰.۲۷ ثانیه برای پاسخ‌های API          |
| تایپ یک کاربر واقعی (۴ فیلد سازمان، ۳ فیلد provider، ۱ دکمه)       | حدود ۶۰ تا ۹۰ ثانیه (تخمین)           |
| **جمع**                                                            | **حدود ۲ تا ۲.۵ دقیقه، زیر ۳ دقیقه**  |

کلید ساخته‌شده در ویزارد بلافاصله در گیت‌وی کار کرد: `GET /v1/models` با آن کلید پاسخ 200 داد، چون snapshot تازه از `config:updated` رسید.

## صفحهٔ Health (کارت ۷.۸)

- **منبع**: `GET /orgs/:orgId/health/runtime`.
  - breaker هر provider و مدل، و cooldown، lockout و غیرفعالی هر credential، از گیت‌وی که بین replicaها همگام است.
  - **نودهای گیت‌وی** از heartbeat روی Valkey: هر نود هر ۵ ثانیه `dirouter:gateway:node:<instance>` را با `configVersion`، `ready` و `lastSeen` می‌نویسد، با انقضای ۱۵ ثانیه. نودی که بمیرد بعد از ۱۵ ثانیه از فهرست حذف می‌شود.
- **تازه‌سازی**: هر ۵ ثانیه (`refetchInterval`) انجام می‌شود و زمان آخرین به‌روزرسانی بالای صفحه است. زمان‌های باقی‌مانده (cooldown، باز شدن breaker، lockout) به ثانیه نشان داده می‌شوند.
- **ریست دستی**: فقط OWNER و ADMIN (مجوز `health:write`)، با `POST /orgs/:orgId/health/reset {scope: provider|model|credential, id}`.
  - control-api مالکیت را بررسی می‌کند. شناسهٔ سازمان دیگر 404 می‌گیرد.
  - رویداد `reset` روی کانال `dirouter:health` منتشر می‌شود. همهٔ گیت‌وی‌ها breaker را می‌بندند، یا cooldown، lockout و غیرفعالی credential را پاک می‌کنند.
  - در audit log با `health.reset` ثبت می‌شود. پاسخ تعداد گیت‌وی‌هایی را که پیام را گرفتند برمی‌گرداند.
  - VIEWER و MEMBER دکمهٔ ریست را نمی‌بینند و API به آن‌ها 403 می‌دهد.

بررسی (۲۰۲۶-۱۱-۰۸):

- **compose**:
  - breaker `mock-down` بعد از ۶ خطا در گیت‌وی `open` بود.
  - ریست از API پاسخ `gatewaysNotified: 1` داد و وضعیت در گیت‌وی بلافاصله `closed` شد.
  - رکورد `health.reset|provider|prv_mock-down` در audit_logs ثبت شد.
  - صفحه در مرورگر در ۱۱ ثانیه ۲ درخواست تازه فرستاد، و نود و نسخهٔ config (۱۷) را نشان داد.
- **تست‌ها**:
  - داشبورد: تازه‌سازی با زمان‌سنج ساختگی، دکمهٔ ریست برای OWNER و ارسال درخواست درست، و نبودن دکمه برای VIEWER.
  - integration در control-api: heartbeat نود، انتشار ریست روی Valkey، ثبت در audit، 403 برای VIEWER و 404 برای شناسهٔ سازمان دیگر.
  - routing: ریست breaker، cooldown و lockout.

> **نکتهٔ dev**: `app.localhost` و `admin.localhost` برای مرورگر دو site جدا هستند، چون `localhost` دامنهٔ قابل‌ثبت ندارد. پس کوکی refresh با `SameSite=Strict` بعد از reload صفحه فرستاده نمی‌شود و باید دوباره وارد شد. در production (`app.example.com` و `admin.example.com` زیر یک site) این مشکل نیست. control-api کوکی را در dev روی http بدون `Secure` و در production همیشه با `Secure` می‌فرستد.

## صفحهٔ Overview (کارت ۷.۳)

- **بازهٔ زمانی سراسری**: ۲۴ ساعت، ۷ روز یا ۳۰ روز (`lib/range.ts`، ذخیره در `localStorage` با کلید `dirouter.range`). Request Log وقتی from/to در URL نباشد از همین بازه استفاده می‌کند.
  - مرزها به ساعت گرد می‌شوند تا کلید کش در رفرش خودکار ثابت بماند.
  - دانه‌بندی نمودار: ساعتی برای ۲۴h و ۷d، روزانه برای ۳۰d.
- **KPIها** از `GET /orgs/:org/stats/overview`: درخواست، توکن، هزینه، نرخ خطا، p50، p95، میانگین TTFT و کلید فعال.
  - برای هر KPI، تغییر درصدی نسبت به دورهٔ قبل با همان طول (فراخوانی دوم overview) نمایش داده می‌شود.
  - رنگ تغییر: سبز وقتی بهتر است (درخواست یا توکن بیشتر، خطا یا تأخیر کمتر).
- **نمودار سری زمانی** (`components/charts/bar-chart.tsx`): SVG سبک و بدون کتابخانه (Recharts و ECharts ده‌ها کیلوبایت به bundle اضافه می‌کردند).
  - انتخاب معیار: درخواست (با بخش خطا به رنگ قرمز)، هزینه یا خطا
  - در RTL محور زمان برعکس است
  - ستون‌ها با کلیک و کیبورد (Enter یا Space) انتخاب می‌شوند
- **top**: مدل‌ها، کلیدها و پروژه‌ها بر اساس هزینه (`stats/top`، ۵ مورد).
- **وضعیت providerها**: از `health/runtime`. اگر کاربر دسترسی نداشته باشد، کارت پنهان می‌شود.
- **رفرش خودکار**: هر ۳۰ ثانیه. با تغییر بازه، دادهٔ قبلی تا رسیدن دادهٔ تازه می‌ماند (`keepPreviousData`) و صفحه چشمک نمی‌زند.
- **drill-down**: همه با فیلترهای داخل URL به `/logs` می‌روند، پس قابل اشتراک‌اند.
  - ستون نمودار → from/to همان سطل؛ روی معیار «خطا»، `status=error` هم اضافه می‌شود.
  - ردیف top → فیلتر `model`، `apiKeyId` یا `projectId`.
  - تاریخ سطل روزانه (`2026-11-08`) به ISO کامل تبدیل می‌شود.

## Request Log، پایه (برای ۷.۳؛ کامل در ۷.۷)

- `/logs` با `validateSearch` (`lib/log-search.ts`): `from`، `to`، `model`، `apiKeyId`، `projectId` و `status`. مقدار نامعتبر حذف می‌شود.
- API: `GET /orgs/:org/logs` با صفحه‌بندی cursor (`useInfiniteQuery`، دکمهٔ «بیشتر»).
- هر فیلتر یک chip با دکمهٔ حذف دارد.

### بررسی (۲۰۲۶-۱۱-۰۸)

- تست‌ها (`app.test.tsx`، ۴ تست تازه):
  - KPIها، مقایسه و وضعیت provider
  - کلیک ستون روی معیار خطا به `/logs` با from/to و status=error
  - کلیک مدل top به فیلتر model، و حذف فیلتر
  - بازهٔ سراسری در `localStorage` می‌ماند
- **زمان بارگذاری با دادهٔ ۳۰ روزه**:
  - داده: ۱۰٬۸۱۵ ردیف ساعتی و ۴۶۵ ردیف روزانه، معادل ۵۴۴٬۲۱۳ درخواست
  - روش: Chrome headless روی dev stack (Vite dev، بدون bundle)، ۵ اجرا
  - از کلیک «ورود» تا رندر KPIها، ۳۱ ستون و top: میانه ۱۷۳ms و بیشینه ۲۵۷ms (معیار: زیر ۱ ثانیه)
  - هر فراخوانی API از Traefik بین ۱۰ و ۳۷ میلی‌ثانیه طول کشید
- **drill-down در مرورگر واقعی**:
  - کلیک ستون امروز → `/logs?from=2026-11-08T00:00:00.000Z&to=2026-11-09T00:00:00.000Z` و ۵۰ ردیف (صفحهٔ اول)
  - این بررسی دو باگ را پیدا کرد که تست واحد نمی‌دید، و هر دو اصلاح شدند:
    - تاریخ روزانه بدون زمان بود
    - مسیر API لاگ‌ها `/logs` است، نه `/stats/logs`

</div>

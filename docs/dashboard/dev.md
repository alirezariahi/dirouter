[English](#english) · [فارسی](#persian)

<a id="english"></a>

# Dashboard: Structure and Conventions

Code: `apps/dashboard` · card 7.1

## Stack

| Area            | Choice                                                               | Why                                                                      |
| --------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Build           | Vite and React 19 with strict TypeScript                             | fast, and a small bundle thanks to route splitting                       |
| Routing         | TanStack Router (code-based)                                         | typed, with preload on hover (`defaultPreload: 'intent'`) and lazy pages |
| Data            | TanStack Query and orval client                                      | no retry on 4xx errors, and a fifteen-second staleTime                   |
| Styling         | Tailwind v4 (`@tailwindcss/vite`) and simple shadcn-style components | no CSS-in-JS; theme uses CSS variables                                   |
| Font            | Vazirmatn Variable (`@fontsource-variable/vazirmatn`)                | local file with unicode-range, no CDN                                    |
| Language        | i18next and react-i18next; Persian by default, and English           |                                                                          |
| Date            | `Intl.DateTimeFormat` with `-u-ca-persian` or `gregory`              | Persian (Solar Hijri) calendar without a library                         |
| command palette | cmdk (`⌘K` / `Ctrl+K`)                                               |                                                                          |

## Folder structure

```
src/
  main.tsx            QueryClient, Settings, Router
  router.tsx          routes; pages with lazyRouteComponent
  settings.tsx        theme and calendar (context); language via i18next
  config.ts           API address: /config.js (nginx) ← VITE_API_URL ← same origin
  i18n/               fa.ts (key source), en.ts (typed from fa), index.ts
  lib/
    api.ts            fetch with access token in memory, automatic refresh on 401, ApiError
    date.ts           formatDate and formatNumber
    prefs.ts          safe localStorage; applyLang (lang and dir) and applyTheme (dark class)
    cn.ts             clsx and tailwind-merge
  components/
    ui/               Button, Card, and states (Loading, Empty, ErrorState)
    layout/           AppShell, CommandPalette, nav
  pages/              one file per page (default export for lazy)
  api/generated.ts    orval output (do not edit by hand)
openapi.json          control-api document for orval
```

## Conventions

- **RTL and LTR**: use only logical properties: `ps-*`, `pe-*`, `ms-*`, `me-*`, `start-*`, `end-*`, `border-s` and `border-e`. Never `left` or `right`, and not `pl`, `pr`, `ml` or `mr`. The sidebar with `border-e` is always on the "start" side: right in Persian and left in English. Changing the language changes `lang` and `dir` on `<html>` (`applyLang`) and is kept in localStorage.
- **Text**: no fixed strings in JSX. Add the key first in `fa.ts`; `en.ts` is typed from it, so a missing key causes a compile error.
- **Colors**: only theme tokens: `bg-bg`, `bg-surface`, `text-fg`, `text-muted`, `border-border`, `bg-brand`, `text-danger`. Dark mode uses `.dark` on `<html>`. The "System" option follows `prefers-color-scheme`.
- **States**: every page that has data uses `Loading`, `Empty` and `ErrorState`. `ErrorState` shows the problem+json message and `requestId`, and has a retry button. The router's `errorComponent` handles route errors.
- **Authentication**: the access token is kept in memory only (not in localStorage), and refresh is done with an httpOnly cookie ([control-api/auth.md](../control-api/auth.md)). Several simultaneous 401s share one refresh.
- **API client**:

  ```bash
  pnpm --filter @dirouter/control-api openapi:export
  pnpm --filter @dirouter/dashboard api:generate
  ```

  Run these after every API change. Typed `useXxx` hooks are generated, and all of them go through `orvalFetch` (the same refresh and ApiError).

- **Shared components**: base components currently live in `src/components/ui`. When another app (such as website) needs them, they move to `packages/ui`.
- **Performance**: every page is lazy and the font is local. Heavy date and icon libraries are forbidden. The Lighthouse performance target on the build is at least 90 (see below).

## Running

```bash
make up                                     # https://app.localhost (behind Traefik)
pnpm --filter @dirouter/dashboard dev       # without Docker: http://localhost:5173 (set VITE_API_URL)
pnpm --filter @dirouter/dashboard test      # jsdom: direction with language, theme, ⌘K, 404, refresh and date
pnpm --filter @dirouter/dashboard build && pnpm --filter @dirouter/dashboard preview
```

## Lighthouse (2026-11-08)

On the build (`vite preview`), with Lighthouse 12, the default mobile profile and simulated throttling, in two runs:

| Category       | Score                                                          |
| -------------- | -------------------------------------------------------------- |
| Performance    | **95** (FCP 2.3s, LCP 2.4s, TBT between 0 and 10ms, CLS 0.001) |
| Accessibility  | 100                                                            |
| Best practices | 96                                                             |

Bundle size:

- initial JS 112KB (gzip).
- the command palette is separate and lazy (17KB) and loads on the first ⌘K. This reduced the initial JS from 149KB to 112KB.
- fonts are local and load based on unicode-range (Arabic 46KB, Latin 35KB).

```bash
pnpm --filter @dirouter/dashboard build && pnpm --filter @dirouter/dashboard preview --port 4173
npx lighthouse http://localhost:4173/ --only-categories=performance
```

## Check in compose

`https://app.localhost` (or `http://app.localhost`) returned 200 and `<html lang="fa" dir="rtl">`. Switching the language to English changed the direction to `ltr` and the labels became English. Switching back to Persian returned `rtl`.

## Login, setup and session (card 7.2)

| Path       | Description                                                                                                                                                                                                                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/setup`   | three-step wizard, only while no user exists yet: 1) organization and owner account, 2) first provider (optional: type, name, baseUrl for compatible or Azure, and key), 3) first virtual key, which also creates the "Default" project. The key is shown only once, with a copy button and the gateway address. |
| `/login`   | email and password                                                                                                                                                                                                                                                                                               |
| `/account` | change password. Afterwards all sessions are closed and the user returns to `/login`.                                                                                                                                                                                                                            |
| Logout     | the "Logout" button in the top bar. The refresh token family is revoked and the cookie is cleared.                                                                                                                                                                                                               |

- **Route protection**: all pages except `/login` and `/setup` are protected under the layout. `beforeLoad` restores the session with the refresh cookie. If there is no session, the user goes to `/setup` if no user exists yet, otherwise to `/login`.
- **Automatic token renewal**: the access token lasts fifteen minutes. Each 401 is retried once with `/auth/refresh` (the refresh is shared between simultaneous requests). If refresh fails, the user is logged out.
- **Error messages**: `lib/errors.ts` maps stable problem+json codes to exact Persian or English text, for example `invalid_credentials` and `login_locked` (with the approximate time), `setup_completed`, `refresh_token_reused`, `forbidden`, `conflict`, network errors, and so on. Per-field validation errors are shown under that field.
- **API address in dev**: built from the page address (`app.` becomes `admin.`). So both `http://app.localhost` and `https://app.localhost` work. CORS in control-api accepts the comma-separated list in `DASHBOARD_ORIGIN`.

### Time from install to first key (2026-11-08)

| Step                                                                               | Time                                        |
| ---------------------------------------------------------------------------------- | ------------------------------------------- |
| `make up` with existing images                                                     | 43 to 51 seconds (previous measurements)    |
| first dashboard load in dev (Vite compile)                                         | about 14 seconds                            |
| full wizard (organization, provider, key), automated in the browser on an empty DB | 0.27 seconds for API responses              |
| typing by a real user (4 organization fields, 3 provider fields, 1 button)         | about 60 to 90 seconds (estimate)           |
| **Total**                                                                          | **about 2 to 2.5 minutes, under 3 minutes** |

The key created in the wizard worked in the gateway immediately: `GET /v1/models` with that key returned 200, because the fresh snapshot arrived from `config:updated`.

## Health page (card 7.8)

- **Source**: `GET /orgs/:orgId/health/runtime`.
  - the breaker of each provider and model, and the cooldown, lockout and disabled state of each credential, from the gateway, which is synced across replicas.
  - **gateway nodes** come from heartbeats on Valkey: each node writes `dirouter:gateway:node:<instance>` every 5 seconds with `configVersion`, `ready` and `lastSeen`, with a 15-second expiry. A node that dies is removed from the list after 15 seconds.
- **Refresh**: every 5 seconds (`refetchInterval`), and the time of the last update is shown at the top of the page. Remaining times (cooldown, breaker opening, lockout) are shown in seconds.
- **Manual reset**: only OWNER and ADMIN (permission `health:write`), with `POST /orgs/:orgId/health/reset {scope: provider|model|credential, id}`.
  - control-api checks ownership. Another organization's ID gets 404.
  - a `reset` event is published on the `dirouter:health` channel. All gateways close the breaker, or clear the cooldown, lockout and disabled state of the credential.
  - it is recorded in the audit log as `health.reset`. The response returns the number of gateways that received the message.
  - VIEWER and MEMBER do not see the reset button, and the API returns 403 to them.

Check (2026-11-08):

- **compose**:
  - breaker `mock-down` was `open` in the gateway after 6 errors.
  - the reset from the API returned `gatewaysNotified: 1`, and the status in the gateway immediately became `closed`.
  - the record `health.reset|provider|prv_mock-down` was written to audit_logs.
  - the page in the browser sent 2 fresh requests in 11 seconds, and showed the node and config version (17).
- **tests**:
  - dashboard: refresh with a fake timer, the reset button for OWNER and the correct request being sent, and the button being absent for VIEWER.
  - integration in control-api: node heartbeat, reset publish on Valkey, audit recording, 403 for VIEWER and 404 for another organization's ID.
  - routing: breaker, cooldown and lockout reset.

> **dev note**: `app.localhost` and `admin.localhost` are two separate sites for the browser, because `localhost` has no registrable domain. So the refresh cookie with `SameSite=Strict` is not sent after a page reload, and you must log in again. In production (`app.example.com` and `admin.example.com` under one site) this problem does not occur. In dev, control-api sends the cookie over http without `Secure`; in production it is always sent with `Secure`.

## Overview page (card 7.3)

- **Global time range**: 24 hours, 7 days or 30 days (`lib/range.ts`, saved in `localStorage` with the key `dirouter.range`). Request Log uses this range when from/to is not in the URL.
  - boundaries are rounded to the hour so the cache key stays stable during automatic refresh.
  - chart granularity: hourly for 24h and 7d, daily for 30d.
- **KPIs** from `GET /orgs/:org/stats/overview`: requests, tokens, cost, error rate, p50, p95, average TTFT, and active keys.
  - for each KPI, the percentage change compared with the previous period of the same length (a second overview call) is shown.
  - change color: green when it is better (more requests or tokens, fewer errors or less latency).
- **Time-series chart** (`components/charts/bar-chart.tsx`): a lightweight SVG without a library (Recharts and ECharts added tens of kilobytes to the bundle).
  - metric choice: requests (with the error section in red), cost, or errors
  - in RTL the time axis is reversed
  - columns are selected with the mouse and keyboard (Enter or Space)
- **top**: models, keys and projects by cost (`stats/top`, 5 items).
- **provider status**: from `health/runtime`. If the user has no access, the card is hidden.
- **Automatic refresh**: every 30 seconds. When the range changes, the previous data stays until new data arrives (`keepPreviousData`), so the page does not flicker.
- **drill-down**: everything goes to `/logs` with filters in the URL, so they can be shared.
  - chart column → from/to of the same bucket; on the "error" metric, `status=error` is also added.
  - top row → `model`, `apiKeyId` or `projectId` filter.
  - the daily bucket date (`2026-11-08`) is converted to a full ISO timestamp.

## Request Log, basics (for 7.3; full version in 7.7)

- `/logs` with `validateSearch` (`lib/log-search.ts`): `from`, `to`, `model`, `apiKeyId`, `projectId` and `status`. Invalid values are removed.
- API: `GET /orgs/:org/logs` with cursor pagination (`useInfiniteQuery`, "More" button).
- each filter is a chip with a delete button.

### Check (2026-11-08)

- tests (`app.test.tsx`, 4 new tests):
  - KPIs, comparison and provider status
  - clicking a column on the error metric goes to `/logs` with from/to and status=error
  - clicking a top model applies the model filter, and removing it
  - the global range persists in `localStorage`
- **load time with 30-day data**:
  - data: 10,815 hourly rows and 465 daily rows, equal to 544,213 requests
  - method: Chrome headless on the dev stack (Vite dev, no bundle), 5 runs
  - from clicking "Login" to rendering the KPIs, 31 columns and top: median 173ms, maximum 257ms (target: under 1 second)
  - each API call from Traefik took between 10 and 37 milliseconds
- **drill-down in a real browser**:
  - clicking today's column → `/logs?from=2026-11-08T00:00:00.000Z&to=2026-11-09T00:00:00.000Z` and 50 rows (first page)
  - this check found two bugs that unit tests did not catch, and both were fixed:
    - the daily date had no time
    - the log API path is `/logs`, not `/stats/logs`

---

<a id="persian"></a>

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
- **احراز هویت**: access token فقط در حافظه است (نه localStorage)، و refresh با کوکی httpOnly انجام می‌شود ([control-api/auth.md](../control-api/auth.md)). چند 401 هم‌زمان یک refresh مشترک دارند.
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

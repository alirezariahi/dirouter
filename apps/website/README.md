[English](#english) · [فارسی](#persian)

<a id="english"></a>

# DiRouter website

The Persian, RTL public homepage uses the selected Orbit design, the Fold logo, and the `#2864F0` brand color. It is a separate workspace application; the administration dashboard is unchanged.

## Run locally

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @dirouter/website dev
```

The development server binds to `http://127.0.0.1:5174/`. For an explicitly requested LAN preview, pass `--host 0.0.0.0`. No gateway, database, API credentials, or external font service is required for the website.

## Production build

```sh
pnpm --filter @dirouter/website build
pnpm --filter @dirouter/website preview --host 127.0.0.1 --port 4174
```

The build type-checks the application and writes the static site to `apps/website/dist/`. Serve that directory at the root of the public site. Current Compose services and the production domain are not changed by this application. The site contains no signup, authentication, or billing integration.

## Interaction and motion

- The routing lab is an explicitly labeled simulation. Normal routing selects OpenAI, failover demonstrates switching to Anthropic, and the cost-policy example selects Mistral. It does not call a provider or show real operational metrics.
- Switching a scenario cancels pending timers. The simulation may be rerun after completion.
- TypeScript, Python, and cURL examples share keyboard-accessible tabs and a copy action with success/failure feedback. Users must supply their own endpoint, virtual key, and configured model alias.
- SVG route particles, gentle node motion, and pointer parallax animate the hero. A global pause control is available. Motion respects `prefers-reduced-motion` and pauses when the document is hidden.
- Sections reveal as they enter the viewport. Content remains visible when reduced motion is requested or motion is paused.
- Mobile navigation supports Escape and returns focus to its toggle. FAQ entries use native disclosure controls.

## Assets and dependencies

The logo and favicon live under `public/`. Vazirmatn is self-hosted through `@fontsource-variable/vazirmatn`; its SIL Open Font License is included with the dependency. Icons are imported individually from `lucide-react`. No external scripts, fonts, telemetry, or images are fetched at runtime.

## Validation

The production build includes strict TypeScript checking. Browser smoke checks cover all routing scenarios, switching scenarios, code tabs and copy, FAQ disclosure, motion pause, mobile navigation, and responsive layouts at 320, 390, 768, and 1440 CSS pixels.

---

<a id="persian"></a>

# وب‌سایت DiRouter

وب‌سایت عمومی فارسی و RTL با طرح انتخاب‌شدهٔ Orbit، لوگوی Fold و رنگ برند `#2864F0` ساخته شده است. این یک برنامه جدا در workspace است؛ داشبورد مدیریتی تغییری نکرده است.

## اجرای محلی

از ریشه مخزن:

```sh
pnpm install --frozen-lockfile
pnpm --filter @dirouter/website dev
```

سرور توسعه به `http://127.0.0.1:5174/` متصل می‌شود. برای پیش‌نمایش شبکه محلی (LAN) که صریحاً درخواست شده، `--host 0.0.0.0` را بدهید. برای وب‌سایت به gateway، پایگاه داده، اعتبارنامه‌های API یا سرویس فونت خارجی نیازی نیست.

## ساخت نسخه تولید

```sh
pnpm --filter @dirouter/website build
pnpm --filter @dirouter/website preview --host 127.0.0.1 --port 4174
```

فرایند build برنامه را با بررسی سخت‌گیرانه TypeScript کنترل می‌کند و سایت ایستا را در `apps/website/dist/` می‌نویسد. این پوشه را در ریشه سایت عمومی سرو کنید. سرویس‌های فعلی Compose و دامنه تولید با این برنامه تغییری نمی‌کنند. سایت شامل ثبت‌نام، احراز هویت یا یکپارچه‌سازی صورت‌حساب نیست.

## تعامل و حرکت

- آزمایشگاه مسیریابی یک شبیه‌سازی با برچسب مشخص است. مسیریابی عادی OpenAI را انتخاب می‌کند، failover نشان می‌دهد که به Anthropic سوئیچ می‌شود و نمونه سیاست هزینه Mistral را انتخاب می‌کند. این بخش هیچ provider را فراخوانی نمی‌کند و شاخص‌های واقعی عملیاتی نشان نمی‌دهد.
- با سوئیچ بین سناریوها، timerهای در انتظار لغو می‌شوند. شبیه‌سازی پس از پایان می‌تواند دوباره اجرا شود.
- نمونه‌های TypeScript، Python و cURL زبانه‌هایی با دسترسی از طریق صفحه‌کلید و یک عملیات کپی با بازخورد موفقیت/شکست دارند. کاربران باید endpoint، virtual key و alias مدل پیکربندی‌شده خودشان را وارد کنند.
- ذرات مسیر SVG، حرکت ملایم گره‌ها و parallax با نشانگر ماوس، هیرو را متحرک می‌کنند. یک کنترل سراسری برای توقف حرکت وجود دارد. حرکت به `prefers-reduced-motion` احترام می‌گذارد و وقتی سند پنهان است متوقف می‌شود.
- بخش‌ها هنگام ورود به viewport نمایان می‌شوند. وقتی حرکت کاهش‌یافته درخواست شده یا متوقف است، محتوا همچنان قابل مشاهده می‌ماند.
- منوی موبایل از Escape پشتیبانی می‌کند و فوکوس را به دکمه باز/بستن برمی‌گرداند. موارد FAQ از کنترل disclosure بومی مرورگر استفاده می‌کنند.

## دارایی‌ها و وابستگی‌ها

لوگو و favicon در `public/` قرار دارند. فونت Vazirmatn به‌صورت self-hosted از `@fontsource-variable/vazirmatn` استفاده می‌کند و مجوز SIL Open Font License آن همراه وابستگی است. آیکون‌ها به‌صورت جداگانه از `lucide-react` وارد می‌شوند. در زمان اجرا هیچ اسکریپت، فونت، telemetry یا تصویر خارجی بارگذاری نمی‌شود.

## اعتبارسنجی

build تولید شامل بررسی سخت‌گیرانه TypeScript است. بررسی‌های دود مرورگر همه سناریوهای مسیریابی، سناریوهای سوئیچ، زبانه‌ها و کپی کد، باز/بسته شدن FAQ، توقف حرکت، ناوبری موبایل و چیدمان‌های واکنش‌گرا در عرض‌های ۳۲۰، ۳۹۰، ۷۶۸ و ۱۴۴۰ پیکسل CSS را پوشش می‌دهند.

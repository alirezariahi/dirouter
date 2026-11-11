[English](feature-comparison.md) · [فارسی](feature-comparison.fa.md)

<div dir="rtl">

# DiRouter — مقایسه‌ی رقبا، فیچر لیست کامل و پیشنهاد معماری

> تاریخ بررسی: ۱۷ آبان ۱۴۰۵ (2026-11-07)
> وضعیت: فقط تحقیق و طراحی، هنوز کدی نوشته نشده است.

---

## ۱. خلاصه‌ی مدیریتی

- این سه پروژه هر کدام در یک حوزه قوی‌اند:
  - **Antirion**: گیت‌وی سازمانی با Rust، سرعت بالا، حاکمیت و دسترسی (SSO، SCIM، RBAC، audit)، guardrail و کلاستر روی Postgres و Valkey.
  - **OmniRoute**: گیت‌وی محلی با بیشترین تعداد provider (۳۵۰+)، ۱۹ استراتژی مسیریابی، فشرده‌سازی کانتکست، حافظه، MCP و A2A.
  - **9Router**: ابزار سبک برای برنامه‌نویس‌ها. فال‌بک سه‌سطحی (اشتراک ← ارزان ← رایگان)، صرفه‌جویی در توکن و ۹ نوع سرویس (چت، embedding، TTS، STT، تصویر، ویدیو، جستجو، fetch).
- **هیچ‌کدام همه‌ی ویژگی‌ها را با هم ندارند:** سطح سازمانی Antirion، تنوع provider و مسیریابی OmniRoute، و **صورت‌حساب و فروش اعتبار** که فقط new-api دارد.
- فرصت DiRouter: یک محصول در یک مونوریپو با **data plane سریع و تاب‌آور**، **control plane کامل** (کاربر، تیم، بودجه، صورت‌حساب) و **داشبورد عملیاتی قوی**.
- **پیشنهاد فنی:** NestJS + React + PostgreSQL برای control plane و داشبورد کاملاً مناسب است. اما **مسیر داغ درخواست‌ها (data plane) بهتر است با Go نوشته شود** (توضیح در بخش ۷). در کنار Postgres هم به **Valkey/Redis** و **ClickHouse** نیاز داریم.

---

## ۲. پروژه‌های بررسی‌شده

| #   | پروژه                                                   | نوع                               | زبان                 | لایسنس                                   | استقرار                                      | تمرکز اصلی                                      |
| --- | ------------------------------------------------------- | --------------------------------- | -------------------- | ---------------------------------------- | -------------------------------------------- | ----------------------------------------------- |
| 1   | **Antirion**                                            | گیت‌وی سازمانی                    | Rust (یک باینری)     | Apache‑2.0، همه‌ی فیچرها رایگان          | فقط Self-host (تک‌نود یا کلاستر، Helm)       | سرعت، حاکمیت، guardrail                         |
| 2   | **OmniRoute**                                           | گیت‌وی محلی و ابری                | Node/TS، Electron    | MIT                                      | npm، Docker، دسکتاپ، Termux، PWA، Cloud پولی | تنوع provider، مسیریابی، فشرده‌سازی             |
| 3   | **9Router**                                             | گیت‌وی محلی برای ابزارهای کدنویسی | Node/TS              | MIT                                      | npm، تونل Cloudflare                         | فال‌بک اشتراک/رایگان، صرفه‌جویی توکن            |
| 4   | **LiteLLM**                                             | Proxy و SDK                       | Python (Rust در بتا) | MIT، بخش Enterprise پولی                 | Docker، Helm، Terraform، Postgres            | استاندارد بازار، ۱۰۰+ provider                  |
| 5   | **Bifrost** (Maxim)                                     | گیت‌وی پرسرعت                     | Go                   | Apache‑2.0، بخش Enterprise پولی          | Docker، باینری                               | سرعت، virtual key، MCP                          |
| 6   | **Portkey Gateway**                                     | گیت‌وی و پلتفرم                   | TS                   | MIT، پلتفرم پولی (مالک فعلی Palo Alto)   | Node، Workers، K8s، Cloud                    | config-based routing، ۵۰+ guardrail             |
| 7   | **new-api** (QuantumNous، نسخه‌ی گسترش‌یافته‌ی one-api) | گیت‌وی فروش API                   | Go + React           | AGPL/MIT*                                | Docker، SQLite/MySQL/PG، ClickHouse          | **صورت‌حساب، شارژ، فروش اعتبار**                |
| 8   | **CLIProxyAPI**                                         | پروکسی اکانت‌های OAuth            | Go                   | MIT                                      | Docker، کلاستر                               | اکانت‌های Codex، Claude Code، Gemini CLI و Grok |
| 9   | **Claude Code Router (CCR)**                            | control plane محلی برای ایجنت‌ها  | TS                   | MIT                                      | npm، دسکتاپ، Docker                          | پروفایل ایجنت، routing شرطی                     |
| 10  | **TensorZero**                                          | گیت‌وی، ارزیابی و بهینه‌سازی      | Rust                 | Apache‑2.0 (**آرشیو شده در خرداد ۱۴۰۵**) | Docker                                       | A/B تست، eval، fine-tune                        |
| 11  | **Helicone AI Gateway**                                 | گیت‌وی و observability            | Rust                 | Apache/GPL (ناهمخوان)                    | npx، Docker، K8s                             | PeakEWMA routing، کش                            |
| 12  | **LLM Gateway** (theopenco)                             | گیت‌وی SaaS و self-host           | TS (Hono، Next.js)   | AGPLv3 و ee                              | Docker unified                               | الگوی مونوریپو و چندمستأجری                     |
| 13  | **OpenRouter**                                          | بازارگاه SaaS (بسته)              | —                    | تجاری                                    | فقط Cloud                                    | اعتبار، BYOK، provider routing                  |
| 14  | **Kong / Envoy AI Gateway / agentgateway**              | پلاگین روی API Gateway            | Lua، Go، Rust        | OSS و Enterprise                         | K8s                                          | تیم‌های پلتفرم                                  |

\* لایسنس new-api را پیش از هر الگوبرداری از کد دوباره بررسی کنید.

> **نکته:** اعداد کارایی (مثل ۰٫۵ms در Antirion یا ۱۱µs در Bifrost) را خود سازنده‌ها گزارش کرده‌اند و هر کدام با روش متفاوتی اندازه گرفته‌اند. این اعداد مستقیماً با هم قابل مقایسه نیستند.

---

## ۳. فیچر لیست کامل (ادغام همه‌ی پروژه‌ها)

راهنمای منبع: **A**=Antirion، **O**=OmniRoute، **N**=9Router، **L**=LiteLLM، **B**=Bifrost، **P**=Portkey، **NA**=new-api، **C**=CLIProxyAPI، **R**=CCR، **T**=TensorZero، **H**=Helicone، **G**=LLM Gateway، **OR**=OpenRouter

اولویت: **P0** = MVP، **P1** = نسخه‌ی ۱، **P2** = بعداً

### ۳.۱ سازگاری API و تبدیل فرمت

| فیچر                                                                     | منبع           | اولویت |
| ------------------------------------------------------------------------ | -------------- | ------ |
| Endpoint سازگار با OpenAI Chat Completions                               | همه            | P0     |
| OpenAI Responses API                                                     | O، NA، C، R    | P0     |
| Anthropic Messages API (برای Claude Code)                                | A، O، NA، C، R | P0     |
| Gemini generateContent / Interactions                                    | A، O، NA، C، R | P1     |
| Bedrock dialect ورودی                                                    | A              | P2     |
| تبدیل دوطرفه‌ی همه‌ی فرمت‌ها، همراه با streaming و tool call و reasoning | A، O، N، NA    | P0     |
| Streaming (SSE) و non-stream                                             | همه            | P0     |
| WebSocket / Realtime API                                                 | NA، P، C       | P2     |
| `/v1/models` و کاتالوگ مدل                                               | O، R           | P0     |
| Function calling / tools / structured output (JSON schema)               | C، T، NA       | P0     |
| ورودی چندرسانه‌ای (تصویر، فایل)                                          | C، T، P        | P1     |
| Drop-in برای SDKهای رسمی، LangChain و Vercel AI SDK (فقط تغییر base URL) | A، B           | P0     |

### ۳.۲ انواع سرویس (Modalities)

| فیچر                                                                   | منبع     | اولویت |
| ---------------------------------------------------------------------- | -------- | ------ |
| Chat/LLM                                                               | همه      | P0     |
| Embeddings                                                             | N، NA، T | P1     |
| Rerank                                                                 | NA       | P2     |
| TTS / STT / Translation                                                | N، NA، P | P2     |
| تولید تصویر                                                            | N، NA، P | P2     |
| تولید ویدیو و تسک‌های async (Midjourney، Suno، Runway) با پیگیری وضعیت | N، NA    | P2     |
| Web search به‌صورت سرویس (Tavily، Brave، Exa، Serper و …)              | N، O     | P2     |
| Web fetch (Firecrawl، Jina Reader)                                     | N        | P2     |
| Batch inference و Files API                                            | T، L     | P2     |
| Fusion: افزودن vision یا web search به مدلی که آن را ندارد             | R        | P2     |

### ۳.۳ Providerها و روش اتصال

| فیچر                                                                                                                                                                                               | منبع           | اولویت         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | -------------- |
| Providerهای اصلی با API key: OpenAI، Anthropic، Gemini، Azure، Bedrock، Vertex، Mistral، Cohere، Groq، Together، Fireworks، DeepSeek، xAI، Cerebras، DeepInfra، Perplexity، OpenRouter، NVIDIA NIM | A، O، L        | P0             |
| هر سرور سازگار با OpenAI (vLLM، Ollama، LM Studio، llama.cpp، SGLang، TGI)                                                                                                                         | همه            | P0             |
| Providerهای ارزان چینی (GLM/Z.AI، Kimi، MiniMax، Qwen، SiliconFlow، Bailian)                                                                                                                       | N، O، R        | P1             |
| **اشتراک‌های OAuth** (Claude Code، Codex، Gemini CLI، Copilot، Cursor، Kimi Code، Grok Build، Antigravity، Kiro)                                                                                   | O، N، C، L     | P1 ⚠️          |
| احراز هویت با web-cookie (ChatGPT Web، Claude Web، Gemini Web)                                                                                                                                     | O، N           | ⚠️ پیشنهاد: نه |
| مسیرهای بدون کلید و رایگان (Pollinations، OpenCode Free، Cloudflare AI)                                                                                                                            | O، N           | P2             |
| چند اکانت یا چند کلید برای هر provider (credential pool)                                                                                                                                           | O، N، C، NA، R | P0             |
| تعریف provider سفارشی با UI و پلاگین                                                                                                                                                               | C، R، NA       | P1             |
| Protocol probing، کشف خودکار مدل‌ها، تست اتصال                                                                                                                                                     | R، NA          | P1             |
| وارد کردن login محلی ابزارها (مثلاً `~/.codex`)                                                                                                                                                    | R              | P2             |
| دیتابیس قیمت مدل‌ها (pricing catalog) به‌روز                                                                                                                                                       | P، O           | P0             |
| Model mapping و alias (اسم مجازی ← مدل واقعی)                                                                                                                                                      | NA، R          | P0             |

> ⚠️ **ریسک حقوقی:** استفاده از اشتراک‌های شخصی (OAuth یا cookie) پشت یک گیت‌وی چندکاربره معمولاً با شرایط استفاده‌ی آن سرویس‌ها مغایرت دارد و می‌تواند به مسدود شدن اکانت منجر شود. 9Router هم خودش هشدار مشابهی برای MITM bridge داده است. **پیشنهاد:** این قابلیت‌ها فقط به‌صورت پلاگین اختیاری و برای استفاده‌ی شخصی ارائه شوند، با هشدار صریح در UI. MITM bridge و web-cookie در هسته نباشند.

### ۳.۴ مسیریابی (Routing)

| فیچر                                                                                          | منبع           | اولویت |
| --------------------------------------------------------------------------------------------- | -------------- | ------ |
| Priority / fill-first (اول سهمیه‌ی اشتراک مصرف شود)                                           | O، N           | P0     |
| Weighted split                                                                                | A، O، P، H، NA | P0     |
| Round-robin و sticky round-robin                                                              | O، N، C        | P0     |
| Least-used / least-busy                                                                       | O، L           | P1     |
| Power-of-two-choices (P2C) و PeakEWMA (بر اساس latency)                                       | O، H           | P1     |
| Least-latency                                                                                 | A، H           | P1     |
| Least-cost / cost-optimized                                                                   | A، O، H، P     | P1     |
| Headroom-aware (هرچه سهمیه‌ی باقی‌مانده بیشتر، اولویت بیشتر)                                  | O              | P1     |
| Reset-aware / reset-window (بر اساس زمان ریست سهمیه)                                          | O              | P1     |
| Last-known-good                                                                               | O              | P1     |
| Context-optimized / context-relay (انتخاب بر اساس طول کانتکست)                                | O              | P1     |
| Cache-optimized (حفظ prompt cache روی همان provider، session affinity)                        | O، NA          | P1     |
| Random / strict-random                                                                        | O              | P2     |
| Fusion / pipeline (ترکیب چند مدل)                                                             | O              | P2     |
| **Classifier / tiered routing** (تشخیص نوع تسک و انتخاب مدل)                                  | A، C           | P1     |
| Aliasهای auto: `auto`، `auto/coding`، `auto/fast`، `auto/cheap`، `auto/smart`، `auto/offline` | O              | P1     |
| امتیازدهی تطبیقی چندعاملی (adaptive scoring، در OmniRoute ۱۵ عامل)                            | O، B(ent)      | P2     |
| **Combo / مدل مجازی:** زنجیره‌ای از مدل‌ها با استراتژی و فال‌بک                               | O، N، R        | P0     |
| Routing شرطی بر اساس header، body، tag یا metadata                                            | P، R، L        | P1     |
| Policy جداگانه برای هر تیم و پروژه، با نمایش سهم ترافیک هر قانون                              | A              | P1     |
| Prefix و بازنویسی درخواست (request rewrite)                                                   | R              | P1     |
| Channel affinity (چسبیدن کاربر به یک کانال)                                                   | NA             | P1     |
| A/B تست و canary، bandit تطبیقی                                                               | T، P           | P2     |

### ۳.۵ تاب‌آوری (Resilience) — اولویت ویژه

| فیچر                                                                           | منبع    | اولویت |
| ------------------------------------------------------------------------------ | ------- | ------ |
| زنجیره‌ی فال‌بک چندسطحی (اشتراک ← API ← ارزان ← رایگان)                        | O، N، A | P0     |
| فال‌بک بر اساس نوع خطا (429، 5xx، timeout، content-policy، context-window)     | P، L    | P0     |
| Retry با backoff نمایی و jitter                                                | A، P، T | P0     |
| **Request hedging** (ارسال موازی به provider دوم وقتی اولی کند است)            | A       | P1     |
| **Circuit breaker** برای هر provider (closed، open، half-open probe)           | A، O    | P0     |
| Cooldown برای هر کلید یا اکانت (بقیه‌ی کلیدها به کار ادامه می‌دهند)            | O، L    | P0     |
| Model lockout (فقط مدلی که rate-limit شده قفل شود، نه کل اتصال)                | O       | P0     |
| Timeout جدا برای اتصال، اولین توکن (TTFT) و کل درخواست                         | P، T    | P0     |
| غیرفعال و فعال‌سازی خودکار کانال بر اساس خطا، و تست دوره‌ای                    | NA      | P0     |
| Health check فعال روی providerها                                               | L، O    | P0     |
| توزیع بار بین کلیدها برای کم کردن فشار rate-limit                              | O، B    | P0     |
| اجرای چندنودی stateless، با شمارنده‌های مشترک در Valkey                        | A، NA   | P0     |
| Graceful shutdown و drain کردن streamهای باز                                   | —       | P0     |
| ادامه‌ی کار وقتی DB یا Redis قطع است (cache محلی config، fail-open قابل تنظیم) | —       | P0     |
| بازیابی streamی که وسط کار قطع شده (در صورت امکان)                             | —       | P2     |

### ۳.۶ کش و صرفه‌جویی در توکن

| فیچر                                                                                                                                    | منبع       | اولویت |
| --------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------ |
| Exact cache (Redis، S3، حافظه) با max-age، max-stale و invalidation                                                                     | A، H، L    | P1     |
| **Semantic cache** (vector store) برای هر مدل، تیم یا کلید                                                                              | A، O، B، P | P1     |
| هدر وضعیت کش (`X-…-Cache: HIT`) و گزارش صرفه‌جویی                                                                                       | O، A       | P1     |
| حسابداری prompt cache خود provider (cache read/write)                                                                                   | NA         | P0     |
| **فشرده‌سازی کانتکست:** session-dedup، فیلتر خروجی ابزارها (git diff، grep، ls، tree)، compaction جدولی، relevance pruning، LLMLingua-2 | O، N       | P1     |
| پروفایل‌های فشرده‌سازی (Lite، Standard، Aggressive، Ultra) با هدر per-request                                                           | O          | P1     |
| حالت خروجی کوتاه (Caveman / terse) با چند سطح                                                                                           | N، O       | P2     |
| پشتیبانی از Anthropic Context Editing و dial بودجه‌ی کانتکست                                                                            | O          | P2     |
| Compression Studio (UI برای آزمایش) و eval آفلاین                                                                                       | O          | P2     |

### ۳.۷ کلید، دسترسی و هویت

| فیچر                                                                       | منبع              | اولویت |
| -------------------------------------------------------------------------- | ----------------- | ------ |
| Virtual / gateway key با مدل‌های مجاز، تاریخ انقضا، IP whitelist و محدودیت | A، L، B، P، NA، R | P0     |
| ذخیره‌ی رمزشده‌ی کلیدهای provider (AES‑256‑GCM، envelope encryption)       | A، O              | P0     |
| اتصال به Vault یا KMS (HashiCorp، AWS KMS)                                 | B(ent)            | P2     |
| سلسله‌مراتب **Org ← Team ← Project ← Key ← User**                          | A، L، B           | P0     |
| نقش‌ها و RBAC سفارشی                                                       | A، P، NA          | P1     |
| SSO: OIDC، SAML، GitHub و Google                                           | A، L، B           | P1     |
| SCIM provisioning و همگام‌سازی دایرکتوری                                   | A، B              | P2     |
| MFA: TOTP، WebAuthn و Passkey                                              | A، NA             | P1     |
| مدیریت session ورود                                                        | NA                | P1     |
| Change request (تأیید تغییرات حساس، مثل four-eyes)                         | A                 | P2     |
| Audit log کامل                                                             | A، L، P           | P1     |
| Model access group                                                         | L                 | P1     |
| ورود با OAuth برای کاربران نهایی (GitHub، Google، Telegram، Discord، OIDC) | NA                | P1     |
| محدودیت دسترسی بر اساس IP و جغرافیا                                        | P(ent)            | P2     |
| شناسه‌ی مشتری نهایی (end-user id) برای ردیابی                              | L، B              | P1     |

### ۳.۸ بودجه، سهمیه و Rate Limit

| فیچر                                                                       | منبع       | اولویت |
| -------------------------------------------------------------------------- | ---------- | ------ |
| Rate limit بر اساس RPM، TPM، تعداد درخواست همزمان و تعداد تصویر            | A، L، H، R | P0     |
| بودجه به دلار یا توکن در همه‌ی سطوح (org، team، project، key، user، model) | A، L، B، H | P0     |
| بازه‌ی بودجه (روزانه، هفتگی، ماهانه) با ریست خودکار                        | L          | P0     |
| پیش‌بینی هزینه و تاریخ تمام شدن بودجه                                      | A          | P1     |
| **Ledger** (دفتر کل) پشت هر عدد هزینه                                      | A          | P0     |
| ردیابی سهمیه‌ی اشتراک‌ها و شمارش معکوس تا ریست                             | N، O       | P1     |
| Fair-share بین اعضای تیمی که یک اشتراک مشترک دارند                         | O          | P2     |
| شمارش استخر سهمیه‌های رایگان بدون محاسبه‌ی تکراری                          | O          | P2     |
| هشدار رسیدن به آستانه‌ی بودجه (۵۰٪، ۸۰٪، ۱۰۰٪)                             | L          | P1     |

### ۳.۹ صورت‌حساب و فروش (Billing / Monetization)

این بخش در Antirion و OmniRoute وجود ندارد. منبع اصلی new-api است که به‌عنوان «پنل فروش API» شناخته می‌شود. ردیف‌هایی که با † علامت خورده‌اند از مستندات و نسخه‌های قبلی آن آمده‌اند و پیش از پیاده‌سازی باید دوباره بررسی شوند.

| فیچر                                                                        | منبع                     | اولویت |
| --------------------------------------------------------------------------- | ------------------------ | ------ |
| کیف پول یا اعتبار پیش‌پرداخت برای کاربر                                     | NA، OR                   | P1     |
| شارژ آنلاین با درگاه (Stripe و †Epay؛ برای ایران: زرین‌پال، IDPay، نکست‌پی) | NA†                      | P1     |
| کد هدیه یا کد شارژ (redemption code)                                        | NA†                      | P1     |
| دعوت و affiliate با پاداش                                                   | NA†                      | P2     |
| پلن‌های اشتراکی (subscription)                                              | NA، G(ent)               | P2     |
| قیمت‌گذاری بر اساس ضریب مدل، ضریب خروجی، ضریب گروه کاربری و ضریب کش         | NA                       | P1     |
| قیمت‌گذاری به ازای هر درخواست (برای تصویر و ویدیو)                          | NA                       | P1     |
| قیمت‌گذاری با عبارت (expression-based) برای پلکان مصرف                      | NA                       | P2     |
| صفحه‌ی عمومی «بازار مدل‌ها» با قیمت‌ها                                      | NA، OR                   | P1     |
| BYOK (کاربر کلید خودش را بیاورد)                                            | OR                       | P1     |
| فاکتور و صورت‌حساب ماهانه و خروجی CSV/PDF                                   | — (هیچ‌کدام کامل ندارند) | P2     |
| گزارش سود: هزینه‌ی خرید از provider در برابر درآمد فروش                     | — (فرصت تمایز)           | P2     |

### ۳.۱۰ Guardrail و امنیت محتوا

| فیچر                                                                       | منبع       | اولویت |
| -------------------------------------------------------------------------- | ---------- | ------ |
| تشخیص PII و secret (کلید API، توکن)                                        | A، O، L، P | P1     |
| Regex و فهرست کلمات                                                        | A، P       | P1     |
| اعتبارسنجی JSON schema خروجی                                               | A، P       | P1     |
| تشخیص prompt injection                                                     | O          | P1     |
| Moderation (provider-agnostic)                                             | A، O       | P1     |
| LLM-as-judge                                                               | A، T       | P2     |
| بررسی مجوز ابزارها (tool-permission)                                       | A          | P2     |
| اعمال روی request، response و **stream**                                   | A          | P1     |
| اقدام‌ها: block، redact با ماسک حافظ فرمت، flag، divert                    | A          | P1     |
| پلاگین guardrail از ارائه‌دهندگان خارجی (۴۰+ در Portkey)                   | P          | P2     |
| لاگ محتوا به‌صورت پیش‌فرض خاموش، و در صورت روشن بودن، PII ماسک یا hash شود | A          | P0     |

### ۳.۱۱ ایجنت، MCP و A2A

| فیچر                                                                                                          | منبع       | اولویت |
| ------------------------------------------------------------------------------------------------------------- | ---------- | ------ |
| **MCP Gateway:** ثبت سرورهای MCP و اعمال کلید، بودجه و لاگ روی آن‌ها                                          | A، L، B، P | P1     |
| MCP server خود گیت‌وی (ابزارهای مدیریتی؛ OmniRoute ۱۱۰ ابزار دارد) روی stdio، HTTP و SSE                      | O          | P2     |
| ارسال هویت کاربر به سرورهای MCP                                                                               | P          | P2     |
| MCP Code Mode                                                                                                 | B          | P2     |
| **A2A:** Agent Card در `/.well-known` و JSON-RPC (`message/send`، `tasks/get`)                                | A، O، L    | P2     |
| پروفایل ایجنت‌ها (Claude Code، Codex، OpenCode و …) با model override و تنظیم یک‌کلیکی                        | R، N، O    | P1     |
| راهنمای نصب برای ابزارها (Claude Code، Codex، Cursor، Cline، Roo، Kilo، Continue، Aider، Goose، Windsurf و …) | O، N       | P0     |
| افزونه‌ی VS Code برای افزودن مدل‌ها به picker                                                                 | O          | P2     |
| حافظه‌ی مکالمه (FTS و vector) با کنترل نگه‌داری                                                               | O          | P2     |
| رله‌ی ایجنت در پیام‌رسان‌ها (Telegram، Slack، Discord)                                                        | R          | P2     |

### ۳.۱۲ Observability و تحلیل

| فیچر                                                                                                                            | منبع       | اولویت |
| ------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------ |
| لاگ هر درخواست: مسیر انتخاب‌شده، **همه‌ی تلاش‌ها و دلیل شکست هرکدام**، توکن، هزینه، وضعیت کش، نتیجه‌ی guardrail، latency و TTFT | A، R، L    | P0     |
| Trace ایجنت و tool call                                                                                                         | R          | P1     |
| Prometheus metrics                                                                                                              | A، B، T، L | P0     |
| OpenTelemetry (trace، metric، log)                                                                                              | A، H، T، L | P1     |
| Log sink خارجی (Langfuse، Datadog، S3، Kafka)                                                                                   | A، L       | P2     |
| دیتابیس لاگ جدا (ClickHouse)                                                                                                    | NA         | P1     |
| Replay درخواست‌های گذشته با مدل یا prompt جدید                                                                                  | T          | P2     |
| ساخت dataset از ترافیک واقعی، eval و feedback                                                                                   | T          | P2     |
| هشدار به Slack، Telegram، Email، Webhook                                                                                        | L، NA†     | P1     |

### ۳.۱۳ پیکربندی و عملیات

| فیچر                                                             | منبع     | اولویت                |
| ---------------------------------------------------------------- | -------- | --------------------- |
| Config اعلانی (YAML) و ویرایش از فایل، API یا کنسول              | A، H     | P1                    |
| اعتبارسنجی با schema، **diff، نسخه‌بندی و rollback**             | A        | P1                    |
| Hot reload بدون ری‌استارت                                        | C، A     | P0                    |
| GitOps                                                           | T        | P2                    |
| Setup wizard اولیه                                               | NA       | P0                    |
| Proxy خروجی (SOCKS5، HTTP) در سطح global، provider یا connection | O، N     | P0 (برای ایران حیاتی) |
| Proxy pool، چرخش IP و relay                                      | N، O     | P1                    |
| تونل برای دسترسی از راه دور (Cloudflare Tunnel)                  | N        | P2                    |
| کنترل egress روی IPv4 و IPv6                                     | O        | P2                    |
| پشتیبانی چندزبانه، شامل **فارسی و RTL**                          | NA       | P0                    |
| Playground مدل‌ها                                                | NA، T، G | P1                    |
| سیستم پلاگین (middleware)                                        | B، NA، R | P2                    |
| Management API کامل (همه‌ی کارهای UI از طریق API)                | C، A     | P0                    |
| SDK برای embed کردن                                              | C        | P2                    |

### ۳.۱۴ استقرار و زنجیره‌ی تأمین

| فیچر                                                   | منبع     | اولویت |
| ------------------------------------------------------ | -------- | ------ |
| Docker image (distroless، non-root) برای amd64 و arm64 | A، O، NA | P0     |
| Docker Compose برای تک‌نود و کلاستر                    | A، C     | P0     |
| Helm chart با autoscaling (HPA)                        | A، L     | P1     |
| حالت تک‌نود سبک (embedded store) برای استفاده‌ی شخصی   | A، O     | P2     |
| npm، دسکتاپ (Electron یا Tauri)، PWA                   | O، N، R  | P2     |
| SBOM، امضای Sigstore و SLSA provenance                 | A        | P2     |
| Benchmark harness منتشرشده                             | A، H     | P1     |

---

## ۴. جدول مقایسه‌ی فیچرها

✅ دارد | ⚠️ جزئی یا فقط نسخه‌ی پولی | ❌ ندارد یا گزارش نشده

| قابلیت                             | Antirion | OmniRoute     | 9Router  | LiteLLM | Bifrost | Portkey | new-api   | CLIProxy | CCR | **DiRouter (هدف)** |
| ---------------------------------- | -------- | ------------- | -------- | ------- | ------- | ------- | --------- | -------- | --- | ------------------ |
| OpenAI / Anthropic / Gemini API    | ✅       | ✅            | ✅       | ✅      | ✅      | ✅      | ✅        | ✅       | ✅  | ✅                 |
| تبدیل فرمت                         | ✅       | ✅            | ✅       | ✅      | ✅      | ✅      | ✅        | ✅       | ✅  | ✅                 |
| تعداد provider                     | ~۱۷      | ۳۵۰+          | ۶۰+      | ۱۰۰+    | ۲۳+     | ۴۵+     | ~۳۰+      | ~۱۰      | ~۱۰ | ۵۰+                |
| اشتراک OAuth                       | ❌       | ✅            | ✅       | ⚠️      | ❌      | ❌      | ❌        | ✅       | ⚠️  | ⚠️ پلاگین          |
| چندرسانه‌ای (تصویر، صوت، ویدیو)    | ❌       | ⚠️            | ✅       | ✅      | ⚠️      | ✅      | ✅        | ❌       | ❌  | ✅                 |
| Combo / مدل مجازی                  | ⚠️       | ✅            | ✅       | ⚠️      | ❌      | ✅      | ⚠️        | ❌       | ✅  | ✅                 |
| تعداد استراتژی routing             | ~۷       | ۱۹            | ۲        | ~۵      | ~۲      | ~۳      | ~۲        | ۱        | ~۲  | ۱۵+                |
| Classifier routing                 | ✅       | ✅ (auto)     | ❌       | ❌      | ❌      | ⚠️      | ❌        | ⚠️       | ⚠️  | ✅                 |
| Circuit breaker                    | ✅       | ✅            | ❌       | ⚠️      | ✅      | ❌      | ⚠️        | ❌       | ❌  | ✅                 |
| Request hedging                    | ✅       | ❌            | ❌       | ❌      | ❌      | ❌      | ❌        | ❌       | ❌  | ✅                 |
| Cooldown کلید و lockout مدل        | ⚠️       | ✅            | ⚠️       | ✅      | ⚠️      | ❌      | ✅        | ⚠️       | ⚠️  | ✅                 |
| Exact cache                        | ✅       | ⚠️            | ❌       | ✅      | ⚠️      | ✅      | ❌        | ❌       | ❌  | ✅                 |
| Semantic cache                     | ✅       | ✅            | ❌       | ✅      | ✅      | ⚠️      | ❌        | ❌       | ❌  | ✅                 |
| فشرده‌سازی کانتکست                 | ❌       | ✅ (۱۲ موتور) | ✅ (RTK) | ❌      | ❌      | ❌      | ❌        | ❌       | ❌  | ✅                 |
| Virtual key و بودجه‌ی سلسله‌مراتبی | ✅       | ⚠️            | ❌       | ✅      | ✅      | ✅      | ✅        | ❌       | ⚠️  | ✅                 |
| Rate limit (RPM/TPM/$)             | ✅       | ✅            | ❌       | ✅      | ✅      | ⚠️      | ⚠️        | ❌       | ✅  | ✅                 |
| SSO / SCIM                         | ✅       | ❌            | ❌       | ⚠️      | ⚠️      | ⚠️      | ⚠️ (OIDC) | ❌       | ❌  | ✅                 |
| MFA / Passkey                      | ✅       | ❌            | ❌       | ❌      | ❌      | ❌      | ✅        | ❌       | ❌  | ✅                 |
| RBAC و Audit                       | ✅       | ❌            | ❌       | ⚠️      | ⚠️      | ✅      | ⚠️        | ❌       | ❌  | ✅                 |
| **صورت‌حساب و شارژ**               | ❌       | ⚠️ (cloud)    | ❌       | ❌      | ❌      | ❌      | ✅        | ❌       | ❌  | ✅                 |
| Guardrail                          | ✅       | ✅            | ❌       | ✅      | ⚠️      | ✅      | ❌        | ❌       | ❌  | ✅                 |
| MCP Gateway                        | ✅       | ✅            | ❌       | ✅      | ✅      | ✅      | ❌        | ❌       | ✅  | ✅                 |
| A2A                                | ✅       | ✅            | ❌       | ✅      | ❌      | ❌      | ❌        | ❌       | ❌  | ✅ (P2)            |
| Prometheus / OTel                  | ✅       | ❌            | ❌       | ✅      | ✅      | ⚠️      | ❌        | ❌       | ❌  | ✅                 |
| داشبورد تحلیلی                     | ✅       | ✅            | ⚠️       | ✅      | ✅      | ⚠️      | ✅        | ❌       | ✅  | ✅++               |
| Config با diff و rollback          | ✅       | ❌            | ❌       | ❌      | ❌      | ❌      | ❌        | ❌       | ❌  | ✅                 |
| Proxy خروجی و pool                 | ❌       | ✅            | ✅       | ⚠️      | ❌      | ❌      | ✅        | ⚠️       | ❌  | ✅                 |
| کلاستر و HA                        | ✅       | ⚠️            | ❌       | ✅      | ⚠️      | ✅      | ✅        | ✅       | ❌  | ✅                 |
| Helm / K8s                         | ✅       | ❌            | ❌       | ✅      | ⚠️      | ✅      | ⚠️        | ❌       | ❌  | ✅                 |
| فارسی و RTL                        | ❌       | ❌            | ❌       | ❌      | ❌      | ❌      | ❌        | ❌       | ❌  | ✅                 |

---

## ۵. طراحی تاب‌آوری (Resilience) برای DiRouter

اصل اول: **Data plane نباید به control plane وابسته باشد.** اگر Postgres، NestJS یا داشبورد از دسترس خارج شوند، ترافیک باید همچنان برقرار بماند.

1. **جدا کردن Data plane و Control plane**
   - Gateway (data plane) config را از control plane می‌گیرد، یک snapshot نسخه‌دار در حافظه و روی دیسک نگه می‌دارد و تغییرات را از Valkey pub/sub یا با long-poll دریافت می‌کند.
   - اگر control plane قطع شود، گیت‌وی با آخرین config سالم به کار ادامه می‌دهد.
2. **Stateless gateway با شمارنده‌های توزیع‌شده**
   - Rate limit و بودجه روی Valkey پیاده می‌شوند (sliding window یا GCRA با Lua script).
   - **Fallback محلی:** اگر Valkey در دسترس نباشد، limiter داخل حافظه با سهمیه‌ی تقسیم‌شده بین نودها کار می‌کند. حالت fail-open یا fail-closed برای هر tenant قابل تنظیم است.
3. **حسابداری غیرهمگام (async)**
   - هزینه‌ی هر درخواست ابتدا در Valkey (برای کنترل لحظه‌ای بودجه) ثبت می‌شود، سپس به صف (NATS JetStream یا Redis Streams) می‌رود و از آنجا در ledger روی Postgres و لاگ در ClickHouse نوشته می‌شود.
   - مسیر درخواست هیچ‌وقت منتظر نوشتن در دیتابیس نمی‌ماند.
   - **Idempotency key** جلوی دوبار شمرده شدن هزینه را می‌گیرد. یک outbox محلی روی دیسک هم برای زمانی است که صف قطع شده.
4. **سه لایه ایزوله‌سازی خطا** (الگوی OmniRoute): circuit breaker برای provider، cooldown برای هر کلید، lockout برای هر مدل. هر سه با half-open probe و backoff تطبیقی.
5. **Hedging و timeoutها:** timeout جداگانه برای اتصال، TTFT و idle در stream. اگر TTFT از p95 بیشتر شود، درخواست به‌صورت hedge به provider دوم هم ارسال می‌شود (فقط برای درخواست‌های idempotent یا با بودجه‌ی hedge مشخص).
6. **Stream-safe failover:** اگر هنوز هیچ بایتی به کلاینت ارسال نشده، فال‌بک کامل انجام می‌شود. اگر بخشی از پاسخ ارسال شده، خطای استاندارد برگردانده می‌شود. ادامه‌ی پاسخ از provider دیگر به‌صورت آزمایشی (P2) بررسی می‌شود.
7. **Bulkhead:** connection pool و concurrency limit جدا برای هر provider و هر tenant، تا یک provider کند یا یک مشتری پرمصرف کل سیستم را از کار نیندازد.
8. **زیرساخت:**
   - Postgres با Patroni یا CloudNativePG (primary + replica) و PgBouncer
   - Valkey Sentinel یا Cluster
   - ClickHouse (تک‌نود در شروع)
   - چند replica از gateway پشت LB، با PodDisruptionBudget، readiness و liveness probe و graceful drain برای SSE
9. **Chaos و تست بار:** k6 یا vegeta، و یک mock provider که 429، 5xx و latency تصادفی تولید کند و در CI اجرا شود. SLO پیشنهادی: overhead p99 کمتر از ۵ms و دسترس‌پذیری ۹۹٫۹۵٪.

---

## ۶. داشبورد کاربردی — صفحات پیشنهادی

نقاط قوت همه را با هم ترکیب می‌کنیم: Overview از Antirion، تب‌های Health و Costs از OmniRoute، Model square و Playground از new-api، و لاگ تلاش‌به‌تلاش از Antirion و CCR.

| صفحه                            | محتوا                                                                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Overview**                    | هزینه، تعداد درخواست، توکن، p50/p95/p99 latency، TTFT، نرخ خطا، نرخ cache hit، صرفه‌جویی (کش، فشرده‌سازی، رایگان)، top models، top teams، **headroom هر provider**                                     |
| **Live / Realtime**             | جریان زنده‌ی درخواست‌ها (WebSocket)، RPS لحظه‌ای، درخواست‌های در حال اجرا، نقشه‌ی provider ← وضعیت                                                                                                     |
| **Health**                      | وضعیت circuit breaker هر provider، کلیدهای در cooldown، مدل‌های قفل‌شده با زمان باز شدن، تاریخچه‌ی incidentها و uptime هر provider                                                                     |
| **Requests (Log Explorer)**     | فیلتر پیشرفته (کلید، تیم، مدل، وضعیت، هزینه، latency)، جزئیات هر درخواست: زنجیره‌ی تلاش‌ها روی timeline، دلیل شکست، نتیجه‌ی guardrail، وضعیت کش، body (در صورت فعال بودن)، دکمه‌ی replay در playground |
| **Costs & Budgets**             | هزینه بر اساس org، team، project، key، user و model، پیش‌بینی هزینه و تاریخ تمام شدن بودجه، ledger، تفکیک «اشتراک، رایگان، پولی»، خروجی CSV                                                            |
| **Quotas**                      | سهمیه‌ی هر اکانت و اشتراک، شمارش معکوس تا ریست، درصد مصرف                                                                                                                                              |
| **Providers & Credentials**     | افزودن provider با wizard، تست اتصال، کشف مدل‌ها، چند کلید برای هر provider، تنظیم proxy برای هر اتصال                                                                                                 |
| **Models / Catalog**            | کاتالوگ با قیمت، طول کانتکست و قابلیت‌ها، alias و mapping، صفحه‌ی عمومی «بازار مدل»                                                                                                                    |
| **Routing / Combos**            | ویرایشگر گرافیکی زنجیره‌ی فال‌بک و استراتژی (drag & drop)، **شبیه‌ساز** (این درخواست کجا می‌رود؟)، سهم ترافیک هر rule                                                                                  |
| **Keys & Access**               | virtual key، مدل‌های مجاز، limitها، انقضا، IP whitelist، چرخش کلید                                                                                                                                     |
| **Org / Teams / Users / Roles** | سلسله‌مراتب، RBAC، SSO و SCIM، دعوت عضو                                                                                                                                                                |
| **Billing**                     | کیف پول، شارژ، کد هدیه، پلن، فاکتور، قیمت‌گذاری گروه‌ها، گزارش سود                                                                                                                                     |
| **Guardrails**                  | تعریف policy، تست زنده، آمار block و redact                                                                                                                                                            |
| **Cache & Compression**         | نرخ hit، صرفه‌جویی، پاک‌سازی کش، Compression Studio                                                                                                                                                    |
| **MCP & Agents**                | ثبت سرورهای MCP، دسترسی ابزارها، لاگ tool callها، پروفایل ایجنت‌ها با snippet آماده برای Claude Code، Codex و …                                                                                        |
| **Playground**                  | مقایسه‌ی کنار‌به‌کنار چند مدل با نمایش هزینه و latency                                                                                                                                                 |
| **Config**                      | ویرایش YAML با اعتبارسنجی، diff، تاریخچه، rollback، change request                                                                                                                                     |
| **Alerts**                      | قانون هشدار (بودجه، نرخ خطا، قطعی provider) و کانال‌ها (Telegram، Slack، Email، Webhook)                                                                                                               |
| **Audit Log**                   | همه‌ی تغییرات با diff                                                                                                                                                                                  |

نکات UX:

- RTL و LTR کامل، تقویم شمسی و میلادی، تم روشن و تیره
- بازه‌ی زمانی سراسری، drill-down از هر نمودار به لاگ‌ها، لینک قابل اشتراک برای هر فیلتر
- Command palette (⌘K)

---

## ۷. پیشنهاد تکنولوژی

### ۷.۱ ارزیابی انتخاب شما (NestJS + React + PostgreSQL)

| لایه                                                           | انتخاب شما | ارزیابی                                                                                                                                                                                                                                                                                                                                                | پیشنهاد                                                                                                                                             |
| -------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Control plane** (Admin API، auth، billing، config، گزارش‌ها) | NestJS     | ✅ عالی. ساختار ماژولار، DI، Guard و RBAC، OpenAPI، اکوسیستم خوب                                                                                                                                                                                                                                                                                       | **NestJS** (روی Fastify adapter)                                                                                                                    |
| **Data plane** (مسیر داغ هر درخواست LLM)                       | NestJS     | ⚠️ **مانع کیفیت در این هدف.** DI، interceptorها و pipeهای Nest روی هر درخواست overhead دارند. GC و تک‌رشته‌ای بودن Node در ده‌ها هزار stream همزمان باعث latency دم بلند (p99) و مصرف حافظه‌ی بیشتر می‌شود. رقبای سرعت‌محور (Antirion، Bifrost، Helicone، TensorZero) همه Rust یا Go هستند و پروژه‌های Node (9Router، OmniRoute) محلی و تک‌کاربره‌اند. | **Go** (پیشنهاد اصلی). جایگزین: Rust.                                                                                                               |
| **Frontend**                                                   | React      | ✅                                                                                                                                                                                                                                                                                                                                                     | React + Vite + TypeScript، TanStack Router و Query، shadcn/ui (Radix) + Tailwind (پشتیبانی RTL)، ECharts یا Recharts، TanStack Table، react-i18next |
| **دیتابیس اصلی**                                               | PostgreSQL | ✅ عالی برای کاربر، کلید، config و ledger                                                                                                                                                                                                                                                                                                              | **PostgreSQL 17** + PgBouncer                                                                                                                       |
| **لاگ و آنالیتیکس**                                            | PostgreSQL | ⚠️ برای میلیون‌ها ردیف لاگ در روز و aggregation سریع داشبورد ضعیف است                                                                                                                                                                                                                                                                                  | **ClickHouse** (مثل new-api). اگر حجم کم است، شروع با TimescaleDB هم ممکن است.                                                                      |
| **شمارنده، کش و pub/sub**                                      | —          | لازم است                                                                                                                                                                                                                                                                                                                                               | **Valkey** (فورک باز Redis)                                                                                                                         |
| **صف رویداد**                                                  | —          | لازم است                                                                                                                                                                                                                                                                                                                                               | **NATS JetStream** (یا Redis Streams در شروع)                                                                                                       |
| **Vector (semantic cache و حافظه)**                            | —          | لازم است                                                                                                                                                                                                                                                                                                                                               | **pgvector** روی همان Postgres. در مقیاس بالا: Qdrant                                                                                               |

<a id="72-why-go-fa"></a>

### ۷.۲ چرا Go برای data plane؟

- Overhead زیر ۱ms و latency دم پایدار (Bifrost این را با Go نشان داده است).
- Goroutine برای هزاران stream همزمان SSE مناسب است و `net/http` و `httputil` بالغ هستند.
- CLIProxyAPI و new-api هم با Go نوشته شده‌اند و می‌توان از الگوهایشان (translatorها، executorها) یاد گرفت.
- یادگیری Go برای تیم TS ساده‌تر از Rust است. Rust فقط وقتی ارزشش را دارد که بخواهید رقیب مستقیم Antirion در benchmark باشید.
- **اگر تیم فقط TypeScript بلد است:** data plane را با **Node + Fastify یا uWebSockets خالص (بدون Nest)** به‌صورت سرویس جدا بنویسید و رابط آن را ثابت نگه دارید، تا بعداً بتوانید آن را با Go جایگزین کنید. اما برای هدف «تاب‌آوری خوب در مقیاس بالا»، Go انتخاب بهتری است.

### ۷.۳ ساختار مونوریپو پیشنهادی

```
dirouter/
├─ apps/
│  ├─ gateway/          # Go — data plane (routing، fallback، limiter، translator)
│  ├─ control-api/      # NestJS — admin/management API، auth، billing، config
│  ├─ worker/           # NestJS — مصرف صف: ledger، aggregation، هشدار، health probe
│  ├─ dashboard/        # React + Vite — کنسول مدیریت
│  ├─ portal/           # React — پنل کاربر نهایی، شارژ و بازار مدل (اختیاری)
│  └─ docs/             # مستندات (Astro Starlight یا Docusaurus)
├─ packages/
│  ├─ contracts/        # JSON Schema / OpenAPI / Protobuf مشترک بین Go و TS
│  ├─ model-catalog/    # دیتابیس قیمت و قابلیت مدل‌ها (JSON نسخه‌دار)
│  ├─ ui/               # کامپوننت‌های مشترک React
│  ├─ sdk-ts/           # SDK مدیریتی
│  └─ config/           # eslint، tsconfig و …
├─ deploy/  (docker-compose، helm، k8s)
└─ tools/   (mock-provider، load-test، chaos)
```

- ابزار مونوریپو: **pnpm workspaces + Turborepo** (یا **Nx** که Go را هم با پلاگین مدیریت می‌کند)
- ORM در NestJS: **Drizzle** یا **Prisma** (شما در پروژه‌های دیگر Prisma دارید و می‌توانید همان را ادامه دهید). Migration از یک منبع واحد اجرا شود.
- قرارداد بین Go و TS: config snapshot به‌صورت JSON و schema مشترک. ارتباط داخلی با gRPC یا HTTP، به‌علاوه‌ی Valkey pub/sub.

---

## ۸. نقشه‌ی راه پیشنهادی

| فاز          | محتوا                                                                                                                                                                                                                                                                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MVP (P0)** | API‌های OpenAI و Anthropic و تبدیل بین آن‌ها، ~۱۵ provider اصلی + هر سرور OpenAI-compatible، combo و فال‌بک چندسطحی، circuit breaker، cooldown، lockout، retry، timeout، virtual key، org/team/project، rate limit و بودجه، ledger، لاگ درخواست‌ها، proxy خروجی، داشبورد Overview، Health، Requests، Providers، Keys و Combos، فارسی و RTL، Docker Compose |
| **v1 (P1)**  | Gemini و Responses API کامل، استراتژی‌های latency، cost، headroom و classifier، hedging، کش exact و semantic، فشرده‌سازی (RTK و dedup)، SSO و MFA و RBAC و audit، guardrailها، MCP gateway، billing (کیف پول، درگاه، کد هدیه، ضریب‌ها)، ClickHouse، OTel و Prometheus، Helm، config با diff و rollback، playground، alerts                                 |
| **v2 (P2)**  | چندرسانه‌ای کامل (تصویر، صوت، ویدیو، جستجو)، A2A، حافظه، SCIM، پلاگین‌ها، A/B و eval، افزونه‌ی VS Code، دسکتاپ، پلاگین اختیاری اشتراک‌های OAuth (با هشدار ToS)، SBOM و امضا                                                                                                                                                                                |

---

## ۹. موارد نیازمند تصمیم شما

1. **مدل کسب‌وکار:** محصول فقط self-host سازمانی است (مثل Antirion) یا پنل فروش API هم دارد (مثل new-api و OpenRouter)؟ این انتخاب وزن بخش billing را تعیین می‌کند.
2. **اشتراک‌های OAuth و web-cookie:** با توجه به ریسک ToS، این قابلیت‌ها کنار گذاشته شوند، به‌صورت پلاگین اختیاری باشند یا در هسته قرار بگیرند؟
3. **زبان data plane:** Go (پیشنهاد)، Rust، یا Node خالص؟
4. **درگاه پرداخت:** ایرانی، بین‌المللی یا هر دو؟

---

## منابع

- https://antirion.ai/
- https://www.omniroute.online/ — https://github.com/cheaper-inference/OmniRoute
- https://9router.com/ — https://github.com/decolua/9router
- https://docs.litellm.ai/docs/simple_proxy
- https://github.com/maximhq/bifrost
- https://github.com/Portkey-AI/gateway
- https://github.com/QuantumNous/new-api — https://docs.newapi.ai/
- https://github.com/router-for-me/CLIProxyAPI
- https://github.com/musistudio/claude-code-router
- https://github.com/tensorzero/tensorzero
- https://github.com/Helicone/ai-gateway
- https://github.com/theopenco/llmgateway
- https://www.getmaxim.ai/articles/top-5-portkey-alternatives-in-2026/
- https://llmgateway.io/blog/litellm-alternatives
- https://coworker.ai/blog/litellm-alternatives

</div>

[English](playground.md) · [فارسی](playground.fa.md)

# محیط آزمایش (Playground)

کد: `apps/dashboard/src/pages/playground.tsx` (توابع stream در `src/lib/playground-stream.ts` و
متن‌ها در `src/i18n/playground-stream.ts`) · کارت‌های 16.5 و 25.6 · مسیر `/playground`.

یک پرامپت هم‌زمان روی حداکثر چهار مدل اجرا می‌شود. هر ستون **به‌صورت stream** و زنده نشان می‌دهد:

- متن همان‌طور که می‌رسد، استدلال اگر مدل بفرستد، و **فراخوانی ابزار** (نام و آرگومان‌ها که از
  تکه‌های stream سرهم می‌شوند)؛
- **TTFT** (زمان تا اولین تکهٔ متن، استدلال یا فراخوانی ابزار)، تأخیر، توکن ورودی/خروجی، هزینهٔ
  تخمینی، وضعیت HTTP و دلیل پایان؛
- **headerهای `x-dirouter-*`** گیت‌وی (مدل، ارائه‌دهنده، تعداد تلاش، کش و …) و `x-request-id`.

درخواست همان چیزی را دارد که مشتری واقعی می‌فرستد: پرامپت سیستمی، **تصویر پیوست** (PNG، JPEG،
WebP یا GIF که در مرورگر تا ۱۰۲۴ پیکسل کوچک می‌شود)، **تعریف ابزارها** به شکل JSON ‏`tools` در
OpenAI همراه `tool_choice`، و `max_tokens`، `temperature`، `top_p`، `reasoning_effort` و
`response_format` (`text`، `json_object` یا `json_schema` با schema). دکمهٔ **توقف** همهٔ streamها
و درخواست گیت‌وی را لغو می‌کند.

هزینه به کلید مجازی‌ای ثبت می‌شود که خود کاربر ساخته است (کلید بررسی می‌شود و ذخیره نمی‌شود).

## API

`POST /orgs/:orgId/playground/stream` (مجوز `models:read`) یک مدل را اجرا می‌کند و پاسخ
`text/event-stream` می‌دهد. داشبورد برای هر ستون یک stream باز می‌کند.

| فیلد بدنه                          | فیلد درخواست گیت‌وی                                     |
| ---------------------------------- | ------------------------------------------------------- |
| `apiKey`                           | `Authorization: Bearer …` (باید کلید خود کاربر باشد)    |
| `model`، `prompt`، `system`        | `model`، `messages`                                     |
| `image`                            | بخش `image_url` پیام کاربر (data URL با base64)         |
| `tools`، `toolChoice`              | `tools`، `tool_choice`                                  |
| `maxTokens`، `temperature`، `topP` | `max_tokens`، `temperature`، `top_p`                    |
| `reasoningEffort`                  | `reasoning_effort` (`minimal`، `low`، `medium`، `high`) |
| `responseFormat`                   | `response_format`                                       |

| رویداد  | داده                                                                        |
| ------- | --------------------------------------------------------------------------- |
| `meta`  | `status` و `headers` (`x-dirouter-*` و `x-request-id` گیت‌وی)               |
| `ttft`  | `ms` وقتی اولین تکهٔ متن، استدلال یا فراخوانی ابزار می‌رسد                  |
| `chunk` | یک `chat.completion.chunk` ‏OpenAI بدون تغییر                               |
| `error` | `status`، `code`، `message` (رد گیت‌وی مثل `budget_exceeded` یا قطع stream) |
| `end`   | `latencyMs`، `ttftMs`، `inputTokens`، `outputTokens`، `estimatedCostUsd`    |

کلید نامعتبر پیش از شروع stream یک خطای JSON معمولی است. سقف بدنهٔ control-api یک مگابایت است،
پس data URL تصویر حداکثر ۹۰۰٬۰۰۰ نویسه می‌تواند باشد. `POST playground/compare` (کارت 16.5) همچنان
همهٔ مدل‌ها را یک‌جا و بدون stream پاسخ می‌دهد.

## تست‌ها

- `apps/dashboard/src/pages/playground.test.tsx`: stream چهار مدل با TTFT و header هر ستون،
  فراخوانی ابزار، تصویر با همهٔ پارامترها، اعتبارسنجی محلی و رد گیت‌وی.
- `apps/control-api/src/playground/playground-stream.unit.test.ts`: درخواست گیت‌وی، اعتبارسنجی و
  رویدادهای stream.
- `apps/control-api/src/playground/playground.integration.test.ts`: روی HTTP در برابر
  mock-provider: متن stream‌شده، پارامترها، فراخوانی ابزار، تصویر و کلید ردشده.
- سناریوی `25.6` در `scripts/e2e/sprint-4.mjs` از مسیر گیت‌وی واقعی.

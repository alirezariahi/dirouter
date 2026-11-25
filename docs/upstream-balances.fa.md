[English](upstream-balances.md) · [فارسی](upstream-balances.fa.md)

<div dir="rtl">

# موجودی upstream و تست زمان‌بندی‌شدهٔ کانال (کارت ۳۲.۹)

پیش از آنکه درخواست‌ها شکست بخورند بدانید اعتبار حساب یک provider دارد تمام می‌شود، و کلیدی را
که اعتبار یا دسترسی‌اش را از دست داده ببینید، حتی وقتی فهرست مدل‌ها هنوز پاسخ می‌دهد.

## موجودی upstream

برای providerهایی که API موجودی دارند، گیت‌وی اعتبار باقی‌ماندهٔ هر credential فعال را می‌خواند.

</div>

| Kind          | Request                       | Value                                       | Currency          |
| ------------- | ----------------------------- | ------------------------------------------- | ----------------- |
| `openrouter`  | `GET {base}/credits`          | `data.total_credits − data.total_usage`     | USD               |
| `deepseek`    | `GET {origin}/user/balance`   | `balance_infos[].total_balance` (USD first) | USD or CNY        |
| `moonshot`    | `GET {base}/users/me/balance` | `data.available_balance`                    | USD; CNY on `.cn` |
| `siliconflow` | `GET {base}/user/info`        | `data.totalBalance`                         | CNY               |

<div dir="rtl">

- provider وقتی از یکی از این‌ها استفاده می‌کند که preset آن یکی از این‌ها باشد (`options.preset`،
  که ویزارد افزودن provider تنظیم می‌کند)، یا `options.balance` یکی را نام ببرد (برای Base URL
  سفارشی). `"balance": "none"` آن را خاموش می‌کند. OpenAI، Anthropic و بیشتر providerهای دیگر برای
  کلید API، API موجودی ندارند.
- **زمان‌بندی**: `settings.upstreamBalance` (`enabled` با پیش‌فرض `true`؛ `intervalSeconds` با
  پیش‌فرض `3600` و حداقل ۳۰۰). در هر دور فقط یک replica (قفل Valkey `dirouter:balances:lock`)؛
  نمونه‌ها به فهرست `dirouter:balances:samples` می‌روند و job `balances` در worker (هر ۳۰ ثانیه)
  تازه‌ترین نمونهٔ هر credential را در `credential_balances` نگه می‌دارد.
- استعلام مثل ترافیک از توکن credential، پراکسی و محافظ SSRF در production استفاده می‌کند.
- **صفحهٔ Providers**: هر credential موجودی و زمان استعلامش را نشان می‌دهد؛ «به‌روزرسانی موجودی»
  (`POST /orgs/{org}/providers/{id}/balance`، مجوز `providers:write`) همین حالا استعلام می‌کند.
  استعلام ناموفق آخرین مقدار شناخته‌شده را نگه می‌دارد و خطا را نشان می‌دهد.

### هشدار موجودی کم

نوع قانون هشدار `upstream_balance_low` ([alerts.fa.md](alerts.fa.md) را ببینید): مقدار، کمترین
موجودی میان credentialهای فعال سازمان است که در ۷ روز گذشته استعلام شده‌اند، و قانون وقتی فعال
می‌شود که این مقدار **برابر یا کمتر** از آستانه باشد (به واحد پول provider). جزئیات رویداد
موجودی‌ها را از کم به زیاد فهرست می‌کند. آستانه الزامی است؛ اگر موجودی‌ای شناخته نباشد قانون رد
می‌شود.

## تست زمان‌بندی‌شدهٔ کانال

زمان‌بندی‌ای جدا از health probe فهرست مدل ([concepts/routing.fa.md](concepts/routing.fa.md)): برای
هر credential یک درخواست کوچک واقعی، یعنی یک completion یک‌توکنی روی ارزان‌ترین مدل چت فعال
provider.

</div>

| Setting (`settings.channelTest`) | Default | Description                                           |
| -------------------------------- | ------- | ----------------------------------------------------- |
| `enabled`                        | `false` | off by default                                        |
| `intervalSeconds`                | `3600`  | time between rounds (minimum 60)                      |
| `failureThreshold`               | `2`     | consecutive failures before a credential is disabled  |
| `successThreshold`               | `1`     | consecutive passes before it is restored              |
| `maxPerRound`                    | `20`    | cap of credentials tested per round (rotating window) |

<div dir="rtl">

- **از چرخه خارج می‌شود برای**: خطای احراز هویت (401/403) و تمام شدن اعتبار (`quota`: HTTP 402
  یا خطاهای `insufficient_quota`/billing). قطعی‌ها (5xx، timeout) کار مدارشکن است.
- **بازگشت خودکار** به محض اینکه credential دوباره قبول شود؛ تغییر به همهٔ replicaها می‌رسد. probe
  فهرست مدل هرگز credentialی را که تست کانال خاموش کرده برنمی‌گرداند، چون فهرست مدل حتی بدون
  اعتبار هم پاسخ می‌دهد.
- دلیل خاموشی در صفحهٔ Health با `channel_test:` شروع می‌شود. نتیجه‌ها به‌صورت نمونهٔ health ذخیره
  می‌شوند (تاریخچهٔ uptime؛ هشدار `invalid_credential` نمونه‌های `auth` را می‌شمارد).
- هر تست چند توکن از حساب اپراتور خرج می‌کند و درخواست مشتری نیست: رویداد مصرف نمی‌نویسد. در هر
  دور فقط یک replica (قفل `dirouter:health:channel-test-lock`).

## تست بدون حساب واقعی

mock provider به هر چهار API موجودی پاسخ می‌دهد (`PUT /__mock/balance {"amount": 0.5}` مقدار را
تنظیم می‌کند) — [mock-provider.fa.md](mock-provider.fa.md) را ببینید.

</div>

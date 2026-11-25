[English](passthrough.md) · [فارسی](passthrough.fa.md)

<div dir="rtl">

# مسیرهای pass-through بومی provider (کارت ۳۰.۷)

بعضی endpointهای provider هنوز ترجمه‌ای در DiRouter ندارند: batch، فایل، تکمیل متنی قدیمی، یا
افزونه‌های خود provider. pass-through چنین درخواستی را بی‌تغییر به provider می‌فرستد، ولی پشت همان
کلید مجازی، سقف نرخ، بودجه و لاگ درخواستی که ترافیک ترجمه‌شده دارد.

</div>

```text
{METHOD} /passthrough/{provider-slug}/{path relative to the provider's base URL}
```

```bash
# provider OpenAI با Base URL https://api.openai.com/v1 → POST https://api.openai.com/v1/completions
curl https://api.example.com/passthrough/openai/completions \
  -H "authorization: Bearer $DIROUTER_KEY" \
  -H 'content-type: application/json' \
  -d '{ "model": "gpt-3.5-turbo-instruct", "prompt": "Say hello" }'
```

<div dir="rtl">

## روشن کردن

pass-through **به‌طور پیش‌فرض خاموش است** و دو کلید جدا دارد:

۱. **فهرست مسیرهای مجاز provider**: `options.passthroughPaths` روی provider (صفحهٔ Providers ←
ویرایش ← «مسیرهای مجاز pass-through»، هر خط یکی). هر ورودی به شکل `[METHOD ]/path` و نسبت به
Base URL است؛ `*` در انتها یعنی هر ادامه‌ای. بدون متد، همهٔ متدها (`GET`، `POST`، `PUT`، `PATCH`،
`DELETE`) مجازند. فهرست خالی یعنی هیچ مسیری مجاز نیست.

</div>

```json
{ "passthroughPaths": ["POST /completions", "POST /batches", "/batches/*", "/files*"] }
```

<div dir="rtl">

۲. **مجوز کلید**: `passthroughProviders` روی کلید مجازی (صفحهٔ Keys ← «providerهای
pass-through»): شناسهٔ providerها، یا `*` برای همهٔ providerهای سازمان. خالی یعنی کلید نمی‌تواند از
pass-through استفاده کند. فقط مالک و مدیر سازمان می‌توانند این مجوز را بدهند، چون با credentialهای
سازمان به API خام provider دسترسی می‌دهد.

| بررسی                                                            | پاسخ                              |
| ---------------------------------------------------------------- | --------------------------------- |
| کلید نامعتبر یا بدون کلید                                        | 401                               |
| کلید بدون مجوز برای این provider                                 | 403                               |
| provider در سازمان کلید نیست                                     | 404                               |
| مسیر یا متد خارج از allow-list                                   | 403                               |
| مسیر با `..`، `//`، `%2f`، `%2e` یا `\`                          | 400                               |
| provider از نوع Bedrock یا plugin (احراز هویتی برای افزودن نیست) | 400                               |
| کلید پیش‌پرداخت (کیف پول)                                        | 403 (هزینه از قبل رزرو‌پذیر نیست) |

## چه چیزهایی همچنان اعمال می‌شود

- **احراز هویت** کلید مجازی (انقضا، فهرست IP مجاز).
- **سقف نرخ** (RPM، و TPM بر اساس تخمین تقریبی اندازهٔ بدنه)، **بودجه‌های** کلید، پروژه و تیم، و
  **سقف همزمانی** کلید.
- **گاردریل‌ها**: سیاست‌های درخواست روی همهٔ مقدارهای رشته‌ای بدنهٔ JSON (به‌جز `model`) اجرا
  می‌شوند؛ سیاست مسدودکننده پیش از تماس با provider پاسخ 400 می‌دهد و سیاست پوشاننده بدنه را
  بازنویسی می‌کند. سیاست‌های پاسخ هم به همین شکل روی پاسخ JSON اجرا می‌شوند. استریم و پاسخ دودویی
  بی‌تغییر عبور می‌کنند و سیاست‌هایی که به فراخوانی مدل نیاز دارند (moderation، طبقه‌بند تزریق) روی
  pass-through ارزیابی نمی‌شوند.
- **مصرف**: هر درخواست یک رویداد مصرف با inbound API برابر `passthrough` می‌نویسد. اگر پاسخ usage
  داشته باشد (`usage` در OpenAI و Anthropic، `usageMetadata` در Gemini، حتی درون استریم SSE) و نام
  مدلی را بیاورد که روی همان provider تعریف شده، درخواست با قیمت همان مدل حساب می‌شود؛ وگرنه هزینه
  صفر است. مدل درخواستی در لاگ، `model` بدنه است یا اگر نباشد `{provider}{path}`.

## credential و هدرها

- credential به‌صورت وزنی از میان credentialهای فعال provider که health از چرخه بیرون نکرده انتخاب
  می‌شود؛ احراز هویتش دقیقاً مثل ترافیک عادی افزوده می‌شود (Bearer، `x-api-key` با
  `anthropic-version`، `x-goog-api-key`، `api-key` یا توکن Entra در Azure، توکن service account در
  Vertex) و هدرهای اضافهٔ credential هم می‌آیند. پراکسی خروجی و timeoutها همان تنظیمات provider است.
- **کلید DiRouter کلاینت هرگز به provider نمی‌رسد.** فقط این هدرهای کلاینت فرستاده می‌شوند:
  `content-type`، `accept`، `anthropic-version`، `anthropic-beta`، `openai-beta`، `idempotency-key`.
  پارامتر `key` در query حذف می‌شود.
- به کلاینت برمی‌گردند: `content-type`، `content-disposition`، `cache-control`، `retry-after` و
  هدرهای سقف نرخ provider؛ هرگز `set-cookie`. هدر `x-dirouter-provider` نام provider را می‌دهد.
- retry و fallback ندارد: درخواست‌های pass-through (آپلود فایل، ساخت batch) برای تکرار امن نیستند.

بدنهٔ درخواست به‌صورت بایت خام نگه داشته می‌شود (هر content type، تا ۲۰ مگابایت)، پس آپلود
multipart و بدنهٔ دودویی بی‌تغییر به provider می‌رسند.

</div>

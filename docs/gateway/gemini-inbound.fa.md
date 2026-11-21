[English](gemini-inbound.md) · [فارسی](gemini-inbound.fa.md)

<div dir="rtl">

# ورودی Gemini API (کارت ۱۱.۱)

کلاینت‌های Gemini — از جمله **Gemini CLI** و Google Gen AI SDK — می‌توانند بدون تغییر کد به DiRouter وصل شوند. گیت‌وی همان مسیرهای Google را می‌پذیرد، درخواست را به canonical ترجمه می‌کند و از pipeline معمول مسیریابی، retry، fallback، بودجه و ثبت usage رد می‌کند.

## مسیرها

| متد  | مسیر                                           | توضیح                                   |
| ---- | ---------------------------------------------- | --------------------------------------- |
| POST | `/v1beta/models/{model}:generateContent`       | پاسخ کامل (JSON)                        |
| POST | `/v1beta/models/{model}:streamGenerateContent` | SSE؛ با `?alt=sse` هم سازگار است        |
| POST | `/v1beta/models/{model}:embedContent`          | امبدینگ (کارت ۱۱.۴)                     |
| POST | `/v1beta/models/{model}:batchEmbedContents`    | امبدینگ دسته‌ای (کارت ۱۱.۴)             |
| POST | `/v1beta/models/{model}:countTokens`           | تخمین محلی توکن، بدون فراخوانی upstream |
| GET  | `/v1beta/models`                               | فهرست مدل‌های مجاز کلید                 |

نام مدل در مسیر، **slug مدل DiRouter** است (همان چیزی که در پنل تعریف می‌کنید). پیشوند `models/` هم پذیرفته می‌شود؛ یعنی `/v1beta/models/models/gemini-2.5-flash:generateContent` معادل `/v1beta/models/gemini-2.5-flash:generateContent` است.

## احراز هویت

یکی از این سه روش:

- هدر `x-goog-api-key: dr-...`
- هدر `authorization: Bearer dr-...`
- پارامتر `?key=dr-...` (برای سازگاری با URLهایی که Gemini CLI می‌سازد)

کلید همان virtual key گیت‌وی است؛ تمام محدودیت‌های مدل، rate limit، IP allowlist و بودجهٔ آن اعمال می‌شود.

## اتصال Gemini CLI

```bash
export GOOGLE_GEMINI_BASE_URL="https://api.example.com"
export GEMINI_API_KEY="dr-..."
gemini
```

اگر CLI نسخهٔ شما `GOOGLE_GEMINI_BASE_URL` را نمی‌شناسد، از `GOOGLE_API_KEY`/`GEMINI_API_KEY` برای کلید و از تنظیم base URL همان نسخه استفاده کنید. مسیرهای ساخته‌شده باید به `/v1beta/models/...` برسند.

نمونهٔ درخواست مستقیم:

```bash
curl https://api.example.com/v1beta/models/gemini-2.5-flash:generateContent \
  -H "x-goog-api-key: $DIROUTER_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "systemInstruction": { "parts": [{ "text": "پاسخ کوتاه بده" }] },
    "contents": [{ "role": "user", "parts": [{ "text": "سلام" }] }],
    "generationConfig": { "maxOutputTokens": 256, "temperature": 0.2 }
  }'
```

## ترجمهٔ ورودی (Gemini → canonical)

| Gemini                                                                 | canonical                                                          |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `systemInstruction.parts[].text`                                       | `system[]`                                                         |
| `contents[].role = user / model`                                       | `user` / `assistant`                                               |
| `parts[].text`                                                         | `text`؛ با `thought: true` → `reasoning`                           |
| `inlineData` / `fileData`                                              | تصویر base64 / URL                                                 |
| `functionCall`                                                         | `tool_call` (آرگومان‌ها رشتهٔ JSON؛ `thoughtSignature` داخل شناسه) |
| `functionResponse`                                                     | `tool_result` (شناسه از فراخوانی قبلی هم‌نام)                      |
| `tools[].functionDeclarations[]`                                       | `tools[]`                                                          |
| `toolConfig.functionCallingConfig.mode`                                | `AUTO`→`auto`، `ANY`→`required`، `NONE`→`none`                     |
| `generationConfig.maxOutputTokens/temperature/topP/topK/stopSequences` | همان فیلدهای canonical                                             |
| `generationConfig.thinkingConfig.thinkingBudget`                       | `reasoning.budgetTokens`                                           |
| `generationConfig.responseMimeType=application/json`                   | `json_object` یا با `responseSchema` → `json_schema`               |
| `stream` (از اکشن URL)                                                 | `stream`                                                           |

قطعه‌های بدون معادل با `onDrop` گزارش می‌شوند؛ گیت‌وی آن‌ها را در لاگ debug ثبت می‌کند.

## پاسخ

- پاسخ کامل شکل `GenerateContentResponse` گوگل را دارد: `candidates[].content.parts[]`، `finishReason`، `usageMetadata`، `modelVersion` و `responseId`.
- متن‌های reasoning با `thought: true` برمی‌گردند.
- `functionCall` با `args` شیئی و در صورت وجود، `thoughtSignature` اصلی.
- finishReason: `STOP`، `MAX_TOKENS`، `SAFETY`، `OTHER` (جزئیات در [gemini](../providers/gemini.fa.md)).

### stream

هر رویداد canonical یک data line از نوع `GenerateContentResponse` می‌شود:

1. chunk اول با `content.role = model` و parts خالی،
2. برای هر delta متن یک chunk،
3. reasoning با `thought: true`،
4. `tool_call_start` به شکل `functionCall` با `args: {}` (آرگومان‌ها در stream گوگل یکجا نمی‌آیند؛ کلاینت باید از پاسخ کامل استفاده کند)،
5. chunk پایانی با `finishReason` و `usageMetadata`.

خطای upstream داخل stream به شکل `{"error":{"code":500,...}}` فرستاده می‌شود.

## تست‌ها

- `packages/translator/src/gemini-inbound.test.ts` — golden test برای متن، system، تنظیمات، JSON schema، tools، tool call/response، تصویر، reasoning و stream.
- `apps/gateway/src/gateway.test.ts` — `x-goog-api-key` و `?key=`، مسیر `:generateContent` با مدل slug و پاسخ Gemini.
- `apps/gateway/src/gemini.test.ts` — رفت‌وبرگشت با SDKهای رسمی OpenAI/Anthropic به provider نوع Gemini.

اجرا:

```bash
pnpm --filter @dirouter/translator test
pnpm --filter @dirouter/gateway test
```

</div>

[English](bedrock.md) · [فارسی](bedrock.fa.md)

<div dir="rtl">

# AWS Bedrock (کارت ۱۱.۳)

| فیلد              | مقدار                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| type              | `bedrock`                                                                                                                                  |
| baseUrl           | الزامی؛ مثلاً `https://bedrock-runtime.us-east-1.amazonaws.com`                                                                            |
| options.region    | منطقهٔ SigV4 (پیش‌فرض `us-east-1`)                                                                                                         |
| credential secret | `accessKeyId:secretAccessKey`، `accessKeyId:secretAccessKey:sessionToken` یا JSON `{"accessKeyId":…,"secretAccessKey":…,"sessionToken":…}` |
| چت                | `POST /model/{modelId}/converse`                                                                                                           |
| stream            | `POST /model/{modelId}/converse-stream`                                                                                                    |
| امبدینگ           | پشتیبانی نمی‌شود                                                                                                                           |

## امضا (SigV4)

- با `node:crypto` و بدون SDK AWS امضا می‌شود: `x-amz-date`، `x-amz-content-sha256`، `x-amz-security-token` (در صورت وجود) و `authorization`.
- `host`، `content-type`، `x-amz-security-token` و هدرهای credential بخشی از signed headers هستند.
- canonical URI همان مسیر درخواست است که هر بخش آن یک بار دیگر URI-encode می‌شود (قاعدهٔ SigV4 برای همهٔ سرویس‌ها جز S3): شناسهٔ مدل به شکل `…-v2%3A0` ارسال و به شکل `…-v2%253A0` امضا می‌شود. ARN مدل (`:` و `/`) هم همین‌طور است.
- credential موقت: session token را در secret بگذارید (بخش سوم بعد از `:` یا فیلد `sessionToken` در JSON). `options.sessionToken` فقط وقتی استفاده می‌شود که secret توکن نداشته باشد. متغیر محیطی `AWS_SESSION_TOKEN` خوانده نمی‌شود، چون یک توکن سراسری با جفت‌کلیدهای جداگانهٔ هر credential هم‌خوان نیست.
- منطقه از `options.region` خوانده می‌شود؛ اگر خالی باشد `AWS_REGION` و در نهایت `us-east-1`.

## ترجمهٔ چت

- از **Converse API** استفاده می‌شود، نه InvokeModel؛ پس یک آداپتر برای همهٔ مدل‌های Bedrock کافی است.
- `system[]` → `system[]`، پیام‌ها → `messages[]`، متن/تصویر → `content[]` (`text` / `image`).
- `tool_call` → `toolUse` و `tool_result` → `toolResult`؛ `toolChoice` به `toolChoice` نگاشت می‌شود.
- Converse نقش‌های یک‌درمیان می‌خواهد؛ پس نوبت‌های پیاپی با نقش یکسان ادغام می‌شوند: چند پیام `tool` یک پیام `user` با چند بلوک `toolResult` می‌شود.
- `maxOutputTokens` → `inferenceConfig.maxTokens`، `temperature`، `topP`، `stop` هم نگاشت می‌شوند.
- پاسخ: `output.message.content[]` و `stopReason` (`end_turn`/`tool_use`/`max_tokens`/…) و `usage`.
- stream: قالب باینری `vnd.amazon.eventstream` پارس می‌شود (نه SSE). هر فریم طول‌دار است و دو checksum از نوع CRC-32 (prelude و کل پیام) دارد که هر دو بررسی می‌شوند. نام رویداد از هدر `:event-type` می‌آید (`messageStart`، `contentBlockStart`، `contentBlockDelta`، `contentBlockStop`، `messageStop`، `metadata`) و payload فقط بدنهٔ همان رویداد است.
- `contentBlockIndex` بالادست همان index بلوک canonical است؛ پس بلوک‌های متن، reasoning و ابزار هیچ‌وقت index مشترک ندارند.
- خطاهای داخل stream (`:message-type: exception`) به رویداد `error` با `code` برابر کلاس خطا تبدیل می‌شوند: `throttlingException` → `rate_limit`، `serviceUnavailableException` → `overloaded`، `modelStreamErrorException` / `internalServerException` → `server`، `validationException` → `bad_request`، `modelTimeoutException` → `timeout`. فریم خراب یا ناقص با `server` گزارش می‌شود.

## پیکربندی نمونه

```json
{
  "type": "bedrock",
  "name": "Bedrock us-east-1",
  "baseUrl": "https://bedrock-runtime.us-east-1.amazonaws.com",
  "options": { "region": "us-east-1" },
  "credentials": [{ "name": "prod", "secret": "AKIA...:secret..." }]
}
```

مدل‌ها با شناسهٔ کامل Bedrock تعریف می‌شوند، مثلاً `anthropic.claude-3-5-sonnet-20241022-v2:0` یا `meta.llama3-70b-instruct-v1:0`.

## محدودیت‌ها

- امبدینگ و list models بومی Bedrock در این نسخه پیاده نشده‌اند.
- تصویر در tool_result پشتیبانی نمی‌شود و با گزارش drop حذف می‌شود.
- برای نقش‌های IAM موقت، session token را در secret بگذارید (بخش امضا را ببینید)؛ گیت‌وی آن را تمدید نمی‌کند.

تست‌ها: `packages/providers/src/bedrock.test.ts` برای امضا و eventstream، و `native.test.ts` برای ثبت آداپتر.

</div>

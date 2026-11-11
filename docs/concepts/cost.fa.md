[English](cost.md) · [فارسی](cost.fa.md)

<div dir="rtl">

# محاسبهٔ هزینه و تخمین توکن

کد: `packages/model-catalog/src/cost.ts`، `tokens.ts` و `packages/shared/src/money.ts` · کارت ۶.۲

## پول بدون float

- همهٔ مبالغ رشتهٔ دلاری با حداکثر ۸ رقم اعشار هستند (`UsdAmount`، مطابق `Decimal(18,8)` در Postgres).
- محاسبه با BigInt انجام می‌شود: ۱ دلار = 10^8 واحد. `parseUsd`، `formatUsd` و `sumUsd` در `@dirouter/shared` هستند.
- `costForTokens(tokens, pricePerMTok)` = `tokens × price / 1,000,000` با گرد کردن half-up در رقم هشتم.
- تست «یک میلیون درخواست کوچک»: جمع دقیقاً برابر حاصل‌ضرب است و هیچ خطای اعشاری جمع نمی‌شود.

## فرمول

usage canonical (`inputTokens` کل ورودی را شامل cache می‌شمارد؛ `reasoningTokens` زیرمجموعهٔ `outputTokens` است):

| بخش         | توکن                                   | قیمت                             |
| ----------- | -------------------------------------- | -------------------------------- |
| ورودی عادی  | `inputTokens − cacheRead − cacheWrite` | `inputPerMTok`                   |
| cache read  | `cacheReadTokens`                      | `cacheReadPerMTok`، وگرنه input  |
| cache write | `cacheWriteTokens`                     | `cacheWritePerMTok`، وگرنه input |
| خروجی عادی  | `outputTokens − reasoningTokens`       | `outputPerMTok`                  |
| reasoning   | `reasoningTokens`                      | `reasoningPerMTok`، وگرنه output |

`computeCost` ریز هزینه و `computeCostUsd` جمع را به‌صورت رشته برمی‌گرداند. هزینهٔ درخواست ناموفق صفر است.

قیمت‌ها از `ModelPricing` هر مدل در snapshot می‌آیند. پیش‌فرض‌ها در `packages/model-catalog/src/catalog.json` هستند. ⚠️ قیمت‌های کاتالوگ هنوز با صفحهٔ رسمی هر provider تطبیق داده نشده‌اند (کارت ۳.۸).

## تخمین وقتی provider usage نمی‌دهد

بعضی providerهای OpenAI-compatible در پاسخ یا stream هیچ `usage` نمی‌فرستند. در این حالت:

1. مترجم `usage` پاسخ را خالی می‌گذارد (`CanonicalResponse.usage` اختیاری است). صفر گذاشتن عمداً انجام نمی‌شود تا با «واقعاً صفر» قاطی نشود.
2. گیت‌وی usage را با tokenizer (`js-tiktoken`، `o200k_base`) تخمین می‌زند:
   - **ورودی**: `estimateRequestTokens` شامل system، پیام‌ها (با ۴ توکن سربار هر پیام)، تصویر (۸۵ توکن) و تعریف ابزارها.
   - **خروجی**: در non-stream از محتوای پاسخ (`estimateOutputTokens`)؛ در stream از متن جمع‌شدهٔ `text_delta`، `reasoning_delta`، نام ابزار و `arguments`.
3. همین عدد به کلاینت هم برمی‌گردد: در `usage` پاسخ، و در stream قبل از `[DONE]` یا `message_delta`. پس صورت‌حساب و پاسخ کلاینت یکی هستند.
4. رویداد مصرف `usageEstimated: true` می‌گیرد تا در گزارش‌ها قابل تفکیک باشد.

برای مدل‌های غیر OpenAI، o200k تقریبی است. فیلتر context window در router از `roughTokens` (بدون tokenizer، ~۴ کاراکتر لاتین یا ~۲ کاراکتر غیرلاتین در هر توکن) استفاده می‌کند چون در مسیر داغ است.

## بررسی در compose (۲۰۲۶-۱۱-۰۷)

| مدل dev        | حالت               | ورودی | خروجی | هزینه      | estimated |
| -------------- | ------------------ | ----- | ----- | ---------- | --------- |
| `mock/nousage` | json               | 12    | 8     | 0.00000280 | true      |
| `mock/nousage` | stream             | 12    | 8     | 0.00000280 | true      |
| `mock/small`   | json               | 8     | 10    | 0.00000280 | false     |
| `mock/tool`    | anthropic → openai | 10    | 12    | 0.00000340 | false     |

قیمت مدل‌های dev: input برابر 0.10 و output برابر 0.20 دلار در هر میلیون توکن. مثلاً 10×0.10 + 12×0.20 = 3.4 دلار در میلیون، یعنی 0.0000034 ✓.

</div>

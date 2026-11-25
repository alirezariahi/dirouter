[English](replicate.md) · [فارسی](replicate.fa.md)

<div dir="rtl">

# Replicate

> کارت ۳۱.۶.

| فیلد            | مقدار                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| type            | `openai-compatible`                                                                                                                                                |
| options.preset  | `replicate`                                                                                                                                                        |
| baseUrl پیش‌فرض | `https://api.replicate.com/v1`                                                                                                                                     |
| Chat            | `POST {baseUrl}/models/{owner}/{name}/predictions` با `Prefer: wait=60`؛ نسخهٔ ثابت `owner/name:version` از `POST {baseUrl}/predictions` می‌رود                    |
| Request         | `input.prompt` (یک نوبت کاربر همان‌طور، گفتگوی بلندتر به‌صورت متن پیاپی)، `system_prompt`، `max_tokens`، `temperature`، `top_p`، `top_k`، `seed`، `stop_sequences` |
| Model discovery | `GET {baseUrl}/collections/language-models`                                                                                                                        |
| کلید API        | الزامی (`Authorization: Bearer`، توکن `r8_`)                                                                                                                       |

مدل‌های زبانی Replicate prompt متنی می‌گیرند: ابزار، تصویر و stream با 400 روشن رد می‌شوند (`stream: false` کار می‌کند). پیش‌بینی‌ای که در زمان انتظار تمام نشود خطای سرور حساب می‌شود و fallback می‌خورد.

تست اتصال در صفحهٔ providerها همان درخواست کشف مدل را می‌فرستد. تست قراردادی: `pnpm --filter @dirouter/providers test` (`src/presets.test.ts`، روی mock-provider). اجرای واقعی در برابر API خود Replicate به حساب کاربری نیاز دارد و جزو تست‌های خودکار نبود.

</div>

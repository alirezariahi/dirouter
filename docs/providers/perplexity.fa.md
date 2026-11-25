[English](perplexity.md) · [فارسی](perplexity.fa.md)

<div dir="rtl">

# Perplexity

> کارت ۳۱.۶.

| فیلد            | مقدار                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| type            | `openai-compatible`                                                                                   |
| options.preset  | `perplexity`                                                                                          |
| baseUrl پیش‌فرض | `https://api.perplexity.ai`                                                                           |
| Chat            | `{baseUrl}/chat/completions` (مدل‌های Sonar)                                                          |
| Model discovery | `GET {baseUrl}/v1/models` و همیشه `sonar`، `sonar-pro`، `sonar-reasoning-pro` و `sonar-deep-research` |
| کلید API        | الزامی (`Authorization: Bearer`)                                                                      |

پاسخ Perplexity منابع وبش را دارد و پاسخ OpenAI-format همان‌طور که می‌آید عبور می‌کند. مستند نیست که `/v1/models` مدل‌های Sonar را فهرست کند؛ برای همین فهرست ثابت هم هست.

تست اتصال در صفحهٔ providerها همان درخواست کشف مدل را می‌فرستد. تست قراردادی: `pnpm --filter @dirouter/providers test` (`src/presets.test.ts`، روی mock-provider). اجرای واقعی در برابر API خود Perplexity به حساب کاربری نیاز دارد و جزو تست‌های خودکار نبود.

</div>

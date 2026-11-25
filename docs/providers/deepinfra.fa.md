[English](deepinfra.md) · [فارسی](deepinfra.fa.md)

<div dir="rtl">

# DeepInfra

> کارت ۳۱.۶.

| فیلد            | مقدار                                 |
| --------------- | ------------------------------------- |
| type            | `openai-compatible`                   |
| options.preset  | `deepinfra`                           |
| baseUrl پیش‌فرض | `https://api.deepinfra.com/v1/openai` |
| Chat            | `{baseUrl}/chat/completions`          |
| Model discovery | `GET {baseUrl}/models`                |
| کلید API        | الزامی (`Authorization: Bearer`)      |

تست اتصال در صفحهٔ providerها همان درخواست کشف مدل را می‌فرستد. تست قراردادی: `pnpm --filter @dirouter/providers test` (`src/presets.test.ts`، روی mock-provider). اجرای واقعی در برابر API خود DeepInfra به حساب کاربری نیاز دارد و جزو تست‌های خودکار نبود.

</div>

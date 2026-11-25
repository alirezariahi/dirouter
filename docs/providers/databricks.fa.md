[English](databricks.md) · [فارسی](databricks.fa.md)

<div dir="rtl">

# Databricks Model Serving

> کارت ۳۱.۶.

| فیلد            | مقدار                                                                        |
| --------------- | ---------------------------------------------------------------------------- |
| type            | `openai-compatible`                                                          |
| options.preset  | `databricks`                                                                 |
| baseUrl پیش‌فرض | `https://<workspace>.cloud.databricks.com/serving-endpoints`                 |
| Chat            | `{baseUrl}/chat/completions`؛ مدل همان نام serving endpoint است              |
| Model discovery | `GET {workspace}/api/2.0/serving-endpoints` (نام endpointها)                 |
| کلید API        | الزامی (`Authorization: Bearer`، توکن دسترسی شخصی یا توکن service principal) |

`baseUrl` پیش‌فرض ندارد چون نام workspace شما در آن است.

تست اتصال در صفحهٔ providerها همان درخواست کشف مدل را می‌فرستد. تست قراردادی: `pnpm --filter @dirouter/providers test` (`src/presets.test.ts`، روی mock-provider). اجرای واقعی در برابر API خود Databricks Model Serving به حساب کاربری نیاز دارد و جزو تست‌های خودکار نبود.

</div>

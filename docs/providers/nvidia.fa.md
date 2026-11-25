[English](nvidia.md) · [فارسی](nvidia.fa.md)

<div dir="rtl">

# NVIDIA NIM

> کارت ۳۱.۶.

| فیلد            | مقدار                                                                               |
| --------------- | ----------------------------------------------------------------------------------- |
| type            | `openai-compatible`                                                                 |
| options.preset  | `nvidia`                                                                            |
| baseUrl پیش‌فرض | `https://integrate.api.nvidia.com/v1`                                               |
| Chat            | `{baseUrl}/chat/completions`                                                        |
| Model discovery | `GET {baseUrl}/models`                                                              |
| کلید API        | الزامی (`Authorization: Bearer`، کلید `nvapi-`)؛ NIM خودمیزبان ممکن است کلید نخواهد |

کانتینر NIM خودمیزبان هم همین‌طور: `baseUrl` را `http://<host>:8000/v1` بگذارید.

تست اتصال در صفحهٔ providerها همان درخواست کشف مدل را می‌فرستد. تست قراردادی: `pnpm --filter @dirouter/providers test` (`src/presets.test.ts`، روی mock-provider). اجرای واقعی در برابر API خود NVIDIA NIM به حساب کاربری نیاز دارد و جزو تست‌های خودکار نبود.

</div>

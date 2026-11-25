[English](huggingface.md) · [فارسی](huggingface.fa.md)

<div dir="rtl">

# Hugging Face Inference Providers

> کارت ۳۱.۶.

| فیلد            | مقدار                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| type            | `openai-compatible`                                                                                              |
| options.preset  | `huggingface`                                                                                                    |
| baseUrl پیش‌فرض | `https://router.huggingface.co/v1`                                                                               |
| Chat            | `{baseUrl}/chat/completions`؛ مدل می‌تواند provider را نام ببرد، مثلاً `meta-llama/Llama-3.1-8B-Instruct:novita` |
| Model discovery | `GET {baseUrl}/models`                                                                                           |
| کلید API        | الزامی (`Authorization: Bearer`، توکن `hf_` با مجوز Inference Providers)                                         |

تست اتصال در صفحهٔ providerها همان درخواست کشف مدل را می‌فرستد. تست قراردادی: `pnpm --filter @dirouter/providers test` (`src/presets.test.ts`، روی mock-provider). اجرای واقعی در برابر API خود Hugging Face Inference Providers به حساب کاربری نیاز دارد و جزو تست‌های خودکار نبود.

</div>

[English](openrouter.md) · [فارسی](openrouter.fa.md)

<div dir="rtl">

# OpenRouter

| فیلد                         | مقدار                            |
| ---------------------------- | -------------------------------- |
| type                         | `openai-compatible`              |
| options.preset               | `openrouter`                     |
| baseUrl پیش‌فرض              | `https://openrouter.ai/api/v1`   |
| فیلد سقف خروجی               | `max_tokens`                     |
| stream_options.include_usage | `پشتیبانی می‌شود`                |
| کلید API                     | `الزامی (Authorization: Bearer)` |
| هدرهای ثابت                  | `{"x-title":"DiRouter"}`         |

تست قراردادی: `pnpm --filter @dirouter/providers test` (روی mock-provider).

</div>

# OpenAI

| فیلد                         | مقدار                            |
| ---------------------------- | -------------------------------- |
| type                         | `openai`                         |
| options.preset               | `openai`                         |
| baseUrl پیش‌فرض              | `https://api.openai.com/v1`      |
| فیلد سقف خروجی               | `max_completion_tokens`          |
| stream_options.include_usage | `پشتیبانی می‌شود`                |
| کلید API                     | `الزامی (Authorization: Bearer)` |

تست قراردادی: `pnpm --filter @dirouter/providers test` (روی mock-provider).

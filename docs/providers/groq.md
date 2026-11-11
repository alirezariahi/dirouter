# Groq

| فیلد                         | مقدار                            |
| ---------------------------- | -------------------------------- |
| type                         | `openai-compatible`              |
| options.preset               | `groq`                           |
| baseUrl پیش‌فرض              | `https://api.groq.com/openai/v1` |
| فیلد سقف خروجی               | `max_completion_tokens`          |
| stream_options.include_usage | `پشتیبانی می‌شود`                |
| کلید API                     | `الزامی (Authorization: Bearer)` |

تست قراردادی: `pnpm --filter @dirouter/providers test` (روی mock-provider).

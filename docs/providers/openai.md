[English](#english) · [فارسی](#persian)

<a id="english"></a>

# OpenAI

| Field                        | Value                              |
| ---------------------------- | ---------------------------------- |
| type                         | `openai`                           |
| options.preset               | `openai`                           |
| Default baseUrl              | `https://api.openai.com/v1`        |
| Output token cap field       | `max_completion_tokens`            |
| stream_options.include_usage | Supported                          |
| API key                      | Required (`Authorization: Bearer`) |

Contract test: `pnpm --filter @dirouter/providers test` (against mock-provider).

---

<a id="persian"></a>

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

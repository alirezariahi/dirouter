[English](#english) · [فارسی](#persian)

<a id="english"></a>

# Mistral

| Field                        | Value                              |
| ---------------------------- | ---------------------------------- |
| type                         | `openai-compatible`                |
| options.preset               | `mistral`                          |
| Default baseUrl              | `https://api.mistral.ai/v1`        |
| Output token cap field       | `max_tokens`                       |
| stream_options.include_usage | Not sent                           |
| API key                      | Required (`Authorization: Bearer`) |

Contract test: `pnpm --filter @dirouter/providers test` (against mock-provider).

---

<a id="persian"></a>

# Mistral

| فیلد                         | مقدار                            |
| ---------------------------- | -------------------------------- |
| type                         | `openai-compatible`              |
| options.preset               | `mistral`                        |
| baseUrl پیش‌فرض              | `https://api.mistral.ai/v1`      |
| فیلد سقف خروجی               | `max_tokens`                     |
| stream_options.include_usage | `ارسال نمی‌شود`                  |
| کلید API                     | `الزامی (Authorization: Bearer)` |

تست قراردادی: `pnpm --filter @dirouter/providers test` (روی mock-provider).

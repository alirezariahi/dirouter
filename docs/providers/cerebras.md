[English](#english) · [فارسی](#persian)

<a id="english"></a>

# Cerebras

| Field                        | Value                              |
| ---------------------------- | ---------------------------------- |
| type                         | `openai-compatible`                |
| options.preset               | `cerebras`                         |
| Default baseUrl              | `https://api.cerebras.ai/v1`       |
| Output token cap field       | `max_completion_tokens`            |
| stream_options.include_usage | Supported                          |
| API key                      | Required (`Authorization: Bearer`) |

Contract test: `pnpm --filter @dirouter/providers test` (against mock-provider).

---

<a id="persian"></a>

# Cerebras

| فیلد                         | مقدار                            |
| ---------------------------- | -------------------------------- |
| type                         | `openai-compatible`              |
| options.preset               | `cerebras`                       |
| baseUrl پیش‌فرض              | `https://api.cerebras.ai/v1`     |
| فیلد سقف خروجی               | `max_completion_tokens`          |
| stream_options.include_usage | `پشتیبانی می‌شود`                |
| کلید API                     | `الزامی (Authorization: Bearer)` |

تست قراردادی: `pnpm --filter @dirouter/providers test` (روی mock-provider).

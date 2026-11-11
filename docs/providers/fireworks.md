[English](#english) · [فارسی](#persian)

<a id="english"></a>

# Fireworks AI

| Field                        | Value                                   |
| ---------------------------- | --------------------------------------- |
| type                         | `openai-compatible`                     |
| options.preset               | `fireworks`                             |
| Default baseUrl              | `https://api.fireworks.ai/inference/v1` |
| Output token cap field       | `max_tokens`                            |
| stream_options.include_usage | Supported                               |
| API key                      | Required (`Authorization: Bearer`)      |

Contract test: `pnpm --filter @dirouter/providers test` (against mock-provider).

---

<a id="persian"></a>

# Fireworks AI

| فیلد                         | مقدار                                   |
| ---------------------------- | --------------------------------------- |
| type                         | `openai-compatible`                     |
| options.preset               | `fireworks`                             |
| baseUrl پیش‌فرض              | `https://api.fireworks.ai/inference/v1` |
| فیلد سقف خروجی               | `max_tokens`                            |
| stream_options.include_usage | `پشتیبانی می‌شود`                       |
| کلید API                     | `الزامی (Authorization: Bearer)`        |

تست قراردادی: `pnpm --filter @dirouter/providers test` (روی mock-provider).

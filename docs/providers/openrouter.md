[English](#english) · [فارسی](#persian)

<a id="english"></a>

# OpenRouter

| Field                        | Value                              |
| ---------------------------- | ---------------------------------- |
| type                         | `openai-compatible`                |
| options.preset               | `openrouter`                       |
| Default baseUrl              | `https://openrouter.ai/api/v1`     |
| Output token cap field       | `max_tokens`                       |
| stream_options.include_usage | Supported                          |
| API key                      | Required (`Authorization: Bearer`) |
| Fixed headers                | `{"x-title":"DiRouter"}`           |

Contract test: `pnpm --filter @dirouter/providers test` (against mock-provider).

---

<a id="persian"></a>

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

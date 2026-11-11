[English](#english) · [فارسی](#persian)

<a id="english"></a>

# DiRouter mock

| Field                        | Value                              |
| ---------------------------- | ---------------------------------- |
| type                         | `openai-compatible`                |
| options.preset               | `mock`                             |
| Default baseUrl              | `http://mock-provider:8090/v1`     |
| Output token cap field       | `max_tokens`                       |
| stream_options.include_usage | Supported                          |
| API key                      | Required (`Authorization: Bearer`) |

Contract test: `pnpm --filter @dirouter/providers test` (against mock-provider).

---

<a id="persian"></a>

# DiRouter mock

| فیلد                         | مقدار                            |
| ---------------------------- | -------------------------------- |
| type                         | `openai-compatible`              |
| options.preset               | `mock`                           |
| baseUrl پیش‌فرض              | `http://mock-provider:8090/v1`   |
| فیلد سقف خروجی               | `max_tokens`                     |
| stream_options.include_usage | `پشتیبانی می‌شود`                |
| کلید API                     | `الزامی (Authorization: Bearer)` |

تست قراردادی: `pnpm --filter @dirouter/providers test` (روی mock-provider).

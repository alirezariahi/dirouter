[English](#english) · [فارسی](#persian)

<a id="english"></a>

# vLLM

| Field                        | Value                      |
| ---------------------------- | -------------------------- |
| type                         | `openai-compatible`        |
| options.preset               | `vllm`                     |
| Default baseUrl              | `http://localhost:8000/v1` |
| Output token cap field       | `max_tokens`               |
| stream_options.include_usage | Supported                  |
| API key                      | Optional (local server)    |

Contract test: `pnpm --filter @dirouter/providers test` (against mock-provider).

---

<a id="persian"></a>

# vLLM

| فیلد                         | مقدار                      |
| ---------------------------- | -------------------------- |
| type                         | `openai-compatible`        |
| options.preset               | `vllm`                     |
| baseUrl پیش‌فرض              | `http://localhost:8000/v1` |
| فیلد سقف خروجی               | `max_tokens`               |
| stream_options.include_usage | `پشتیبانی می‌شود`          |
| کلید API                     | `اختیاری (سرور محلی)`      |

تست قراردادی: `pnpm --filter @dirouter/providers test` (روی mock-provider).

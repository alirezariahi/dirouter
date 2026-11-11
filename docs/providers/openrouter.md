[English](openrouter.md) · [فارسی](openrouter.fa.md)

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

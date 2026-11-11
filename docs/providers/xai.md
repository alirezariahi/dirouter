[English](xai.md) · [فارسی](xai.fa.md)

# xAI

| Field                        | Value                              |
| ---------------------------- | ---------------------------------- |
| type                         | `openai-compatible`                |
| options.preset               | `xai`                              |
| Default baseUrl              | `https://api.x.ai/v1`              |
| Output token cap field       | `max_tokens`                       |
| stream_options.include_usage | Supported                          |
| API key                      | Required (`Authorization: Bearer`) |

Contract test: `pnpm --filter @dirouter/providers test` (against mock-provider).

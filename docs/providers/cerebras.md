[English](cerebras.md) · [فارسی](cerebras.fa.md)

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

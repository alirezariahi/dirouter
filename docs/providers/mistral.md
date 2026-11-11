[English](mistral.md) · [فارسی](mistral.fa.md)

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

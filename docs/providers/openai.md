[English](openai.md) · [فارسی](openai.fa.md)

# OpenAI

| Field                        | Value                              |
| ---------------------------- | ---------------------------------- |
| type                         | `openai`                           |
| options.preset               | `openai`                           |
| Default baseUrl              | `https://api.openai.com/v1`        |
| Output token cap field       | `max_completion_tokens`            |
| stream_options.include_usage | Supported                          |
| API key                      | Required (`Authorization: Bearer`) |

Contract test: `pnpm --filter @dirouter/providers test` (against mock-provider).

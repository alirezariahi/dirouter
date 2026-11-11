[English](deepseek.md) · [فارسی](deepseek.fa.md)

# DeepSeek

| Field                        | Value                              |
| ---------------------------- | ---------------------------------- |
| type                         | `openai-compatible`                |
| options.preset               | `deepseek`                         |
| Default baseUrl              | `https://api.deepseek.com/v1`      |
| Output token cap field       | `max_tokens`                       |
| stream_options.include_usage | Supported                          |
| API key                      | Required (`Authorization: Bearer`) |

Contract test: `pnpm --filter @dirouter/providers test` (against mock-provider).

[English](together.md) · [فارسی](together.fa.md)

# Together AI

| Field                        | Value                              |
| ---------------------------- | ---------------------------------- |
| type                         | `openai-compatible`                |
| options.preset               | `together`                         |
| Default baseUrl              | `https://api.together.xyz/v1`      |
| Output token cap field       | `max_tokens`                       |
| stream_options.include_usage | Supported                          |
| API key                      | Required (`Authorization: Bearer`) |

Contract test: `pnpm --filter @dirouter/providers test` (against mock-provider).

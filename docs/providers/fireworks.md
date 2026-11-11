[English](fireworks.md) · [فارسی](fireworks.fa.md)

# Fireworks AI

| Field                        | Value                                   |
| ---------------------------- | --------------------------------------- |
| type                         | `openai-compatible`                     |
| options.preset               | `fireworks`                             |
| Default baseUrl              | `https://api.fireworks.ai/inference/v1` |
| Output token cap field       | `max_tokens`                            |
| stream_options.include_usage | Supported                               |
| API key                      | Required (`Authorization: Bearer`)      |

Contract test: `pnpm --filter @dirouter/providers test` (against mock-provider).

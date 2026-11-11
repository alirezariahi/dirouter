[English](groq.md) · [فارسی](groq.fa.md)

# Groq

| Field                        | Value                              |
| ---------------------------- | ---------------------------------- |
| type                         | `openai-compatible`                |
| options.preset               | `groq`                             |
| Default baseUrl              | `https://api.groq.com/openai/v1`   |
| Output token cap field       | `max_completion_tokens`            |
| stream_options.include_usage | Supported                          |
| API key                      | Required (`Authorization: Bearer`) |

Contract test: `pnpm --filter @dirouter/providers test` (against mock-provider).

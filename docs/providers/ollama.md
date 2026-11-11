[English](ollama.md) · [فارسی](ollama.fa.md)

# Ollama

| Field                        | Value                       |
| ---------------------------- | --------------------------- |
| type                         | `openai-compatible`         |
| options.preset               | `ollama`                    |
| Default baseUrl              | `http://localhost:11434/v1` |
| Output token cap field       | `max_tokens`                |
| stream_options.include_usage | Supported                   |
| API key                      | Optional (local server)     |

Contract test: `pnpm --filter @dirouter/providers test` (against mock-provider).

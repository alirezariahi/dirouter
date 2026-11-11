[English](vllm.md) · [فارسی](vllm.fa.md)

# vLLM

| Field                        | Value                      |
| ---------------------------- | -------------------------- |
| type                         | `openai-compatible`        |
| options.preset               | `vllm`                     |
| Default baseUrl              | `http://localhost:8000/v1` |
| Output token cap field       | `max_tokens`               |
| stream_options.include_usage | Supported                  |
| API key                      | Optional (local server)    |

Contract test: `pnpm --filter @dirouter/providers test` (against mock-provider).

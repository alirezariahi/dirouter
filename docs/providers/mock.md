[English](mock.md) · [فارسی](mock.fa.md)

# DiRouter mock

| Field                        | Value                              |
| ---------------------------- | ---------------------------------- |
| type                         | `openai-compatible`                |
| options.preset               | `mock`                             |
| Default baseUrl              | `http://mock-provider:8090/v1`     |
| Output token cap field       | `max_tokens`                       |
| stream_options.include_usage | Supported                          |
| API key                      | Required (`Authorization: Bearer`) |

Contract test: `pnpm --filter @dirouter/providers test` (against mock-provider).

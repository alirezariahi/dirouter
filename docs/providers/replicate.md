# Replicate

> Card 31.6.

| Field           | Value                                                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| type            | `openai-compatible`                                                                                                                                                      |
| options.preset  | `replicate`                                                                                                                                                              |
| Default baseUrl | `https://api.replicate.com/v1`                                                                                                                                           |
| Chat            | `POST {baseUrl}/models/{owner}/{name}/predictions` with `Prefer: wait=60`; a pinned version `owner/name:version` uses `POST {baseUrl}/predictions`                       |
| Request         | `input.prompt` (one user turn as it is, a longer conversation as a transcript), `system_prompt`, `max_tokens`, `temperature`, `top_p`, `top_k`, `seed`, `stop_sequences` |
| Model discovery | `GET {baseUrl}/collections/language-models`                                                                                                                              |
| API key         | Required (`Authorization: Bearer`, an `r8_` token)                                                                                                                       |

Language models on Replicate take text prompts: tools, images and streaming are refused with a clear 400 (`stream: false` works). A prediction that does not finish within the wait counts as a server error and falls back.

The connection test on the Providers page sends the model discovery request. Contract test: `pnpm --filter @dirouter/providers test` (`src/presets.test.ts`, against mock-provider). A run against the real Replicate API needs an account and was not part of the automated tests.

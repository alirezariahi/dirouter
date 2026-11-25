# Perplexity

> Card 31.6.

| Field           | Value                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| type            | `openai-compatible`                                                                                          |
| options.preset  | `perplexity`                                                                                                 |
| Default baseUrl | `https://api.perplexity.ai`                                                                                  |
| Chat            | `{baseUrl}/chat/completions` (Sonar models)                                                                  |
| Model discovery | `GET {baseUrl}/v1/models`, plus `sonar`, `sonar-pro`, `sonar-reasoning-pro` and `sonar-deep-research` always |
| API key         | Required (`Authorization: Bearer`)                                                                           |

Perplexity answers carry their web sources; the OpenAI-format answer is passed on as it comes. Whether `/v1/models` lists the Sonar models is not documented, hence the fixed list.

The connection test on the Providers page sends the model discovery request. Contract test: `pnpm --filter @dirouter/providers test` (`src/presets.test.ts`, against mock-provider). A run against the real Perplexity API needs an account and was not part of the automated tests.

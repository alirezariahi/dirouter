# Databricks Model Serving

> Card 31.6.

| Field           | Value                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------- |
| type            | `openai-compatible`                                                                      |
| options.preset  | `databricks`                                                                             |
| Default baseUrl | `https://<workspace>.cloud.databricks.com/serving-endpoints`                             |
| Chat            | `{baseUrl}/chat/completions`, the model is the serving endpoint name                     |
| Model discovery | `GET {workspace}/api/2.0/serving-endpoints` (endpoint names)                             |
| API key         | Required (`Authorization: Bearer`, a personal access token or a service principal token) |

`baseUrl` has no default: it contains your workspace host.

The connection test on the Providers page sends the model discovery request. Contract test: `pnpm --filter @dirouter/providers test` (`src/presets.test.ts`, against mock-provider). A run against the real Databricks Model Serving API needs an account and was not part of the automated tests.

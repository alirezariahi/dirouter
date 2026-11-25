# DeepInfra

> Card 31.6.

| Field           | Value                                 |
| --------------- | ------------------------------------- |
| type            | `openai-compatible`                   |
| options.preset  | `deepinfra`                           |
| Default baseUrl | `https://api.deepinfra.com/v1/openai` |
| Chat            | `{baseUrl}/chat/completions`          |
| Model discovery | `GET {baseUrl}/models`                |
| API key         | Required (`Authorization: Bearer`)    |

The connection test on the Providers page sends the model discovery request. Contract test: `pnpm --filter @dirouter/providers test` (`src/presets.test.ts`, against mock-provider). A run against the real DeepInfra API needs an account and was not part of the automated tests.

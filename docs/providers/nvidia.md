# NVIDIA NIM

> Card 31.6.

| Field           | Value                                                                                |
| --------------- | ------------------------------------------------------------------------------------ |
| type            | `openai-compatible`                                                                  |
| options.preset  | `nvidia`                                                                             |
| Default baseUrl | `https://integrate.api.nvidia.com/v1`                                                |
| Chat            | `{baseUrl}/chat/completions`                                                         |
| Model discovery | `GET {baseUrl}/models`                                                               |
| API key         | Required (`Authorization: Bearer`, an `nvapi-` key); a self-hosted NIM may need none |

A self-hosted NIM container is reached the same way: set `baseUrl` to `http://<host>:8000/v1`.

The connection test on the Providers page sends the model discovery request. Contract test: `pnpm --filter @dirouter/providers test` (`src/presets.test.ts`, against mock-provider). A run against the real NVIDIA NIM API needs an account and was not part of the automated tests.

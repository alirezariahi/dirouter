[English](watsonx.md) · [فارسی](watsonx.fa.md)

# IBM watsonx.ai

> Card 31.6.

| Field           | Value                                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| type            | `openai-compatible`                                                                                                                                                                               |
| options.preset  | `watsonx`                                                                                                                                                                                         |
| Default baseUrl | `https://us-south.ml.cloud.ibm.com`                                                                                                                                                               |
| Options         | `projectId` (or `spaceId`), required; `version` (default `2024-10-08`)                                                                                                                            |
| Chat            | `POST {baseUrl}/ml/v1/text/chat?version=…`, streams on `/ml/v1/text/chat_stream`; OpenAI-shaped messages and tools with `model_id` and `project_id`                                               |
| Model discovery | `GET {baseUrl}/ml/v1/foundation_model_specs?filters=function_text_chat`                                                                                                                           |
| API key         | An IBM Cloud API key; the gateway exchanges it for an IAM token (`https://iam.cloud.ibm.com/identity/token`, `options.tokenUrl` to override) and caches the token until shortly before it expires |

Other regions: `https://eu-de.ml.cloud.ibm.com`, `https://jp-tok.ml.cloud.ibm.com`, … Set `projectId` through the API: `PATCH /api/v1/orgs/{org}/providers/{id}` with `{"options": {"preset": "watsonx", "projectId": "…"}}`.

The connection test on the Providers page sends the model discovery request. Contract test: `pnpm --filter @dirouter/providers test` (`src/presets.test.ts`, against mock-provider). A run against the real IBM watsonx.ai API needs an account and was not part of the automated tests.

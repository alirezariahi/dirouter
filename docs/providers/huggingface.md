[English](huggingface.md) · [فارسی](huggingface.fa.md)

# Hugging Face Inference Providers

> Card 31.6.

| Field           | Value                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| type            | `openai-compatible`                                                                                         |
| options.preset  | `huggingface`                                                                                               |
| Default baseUrl | `https://router.huggingface.co/v1`                                                                          |
| Chat            | `{baseUrl}/chat/completions`; a model may name its provider, e.g. `meta-llama/Llama-3.1-8B-Instruct:novita` |
| Model discovery | `GET {baseUrl}/models`                                                                                      |
| API key         | Required (`Authorization: Bearer`, an `hf_` token with Inference Providers permission)                      |

The connection test on the Providers page sends the model discovery request. Contract test: `pnpm --filter @dirouter/providers test` (`src/presets.test.ts`, against mock-provider). A run against the real Hugging Face Inference Providers API needs an account and was not part of the automated tests.

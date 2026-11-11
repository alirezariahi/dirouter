[English](azure-openai.md) · [فارسی](azure-openai.fa.md)

# Azure OpenAI

- `type: azure-openai`, `baseUrl: https://<resource>.openai.azure.com`
- The `upstreamModel` of each model = **deployment name**
- `options.apiVersion` (default `2024-10-21`)
- Authentication uses the `api-key` header; the `model` field is not sent in the body
- Output token cap field: `max_completion_tokens`

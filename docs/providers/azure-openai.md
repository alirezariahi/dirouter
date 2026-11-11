[English](#english) · [فارسی](#persian)

<a id="english"></a>

# Azure OpenAI

- `type: azure-openai`, `baseUrl: https://<resource>.openai.azure.com`
- The `upstreamModel` of each model = **deployment name**
- `options.apiVersion` (default `2024-10-21`)
- Authentication uses the `api-key` header; the `model` field is not sent in the body
- Output token cap field: `max_completion_tokens`

---

<a id="persian"></a>

# Azure OpenAI

- `type: azure-openai`، `baseUrl: https://<resource>.openai.azure.com`
- `upstreamModel` هر مدل = **نام deployment**
- `options.apiVersion` (پیش‌فرض `2024-10-21`)
- احراز هویت با هدر `api-key`؛ فیلد `model` در بدنه فرستاده نمی‌شود
- فیلد سقف خروجی: `max_completion_tokens`

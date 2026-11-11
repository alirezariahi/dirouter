[English](README.md) · [فارسی](README.fa.md)

<div dir="rtl">

# Providerها

| نوع (`type`)        | آداپتر                                        | سند                                                                                                                                                                                                                                                          |
| ------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `openai`            | OpenAI Chat Completions                       | [openai](openai.fa.md)                                                                                                                                                                                                                                       |
| `azure-openai`      | مسیر deployment، `api-version`، هدر `api-key` | [azure-openai](azure-openai.fa.md)                                                                                                                                                                                                                           |
| `openai-compatible` | OpenAI با preset (`options.preset`)           | [openrouter](openrouter.fa.md)، [deepseek](deepseek.fa.md)، [groq](groq.fa.md)، [together](together.fa.md)، [fireworks](fireworks.fa.md)، [mistral](mistral.fa.md)، [xai](xai.fa.md)، [cerebras](cerebras.fa.md)، [ollama](ollama.fa.md)، [vllm](vllm.fa.md) |
| `anthropic`         | Messages API                                  | [anthropic](anthropic.fa.md)                                                                                                                                                                                                                                 |
| `gemini`            | generateContent / streamGenerateContent       | [gemini](gemini.fa.md)                                                                                                                                                                                                                                       |
| `mock`              | provider ساختگی برای تست                      | [mock](mock.fa.md)                                                                                                                                                                                                                                           |

## افزودن provider سازگار جدید (فقط config)

`type: openai-compatible`، `baseUrl` (تا `/v1`)، و در صورت نیاز در `options`:

- `maxTokensField`: `max_tokens` (پیش‌فرض) یا `max_completion_tokens`
- `supportsStreamOptions`: `false` اگر سرور `stream_options` را رد می‌کند
- `headers`: هدرهای ثابت اضافه

</div>

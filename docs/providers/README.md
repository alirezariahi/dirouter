[English](#english) · [فارسی](#persian)

<a id="english"></a>

# Providers

| Type (`type`)       | Adapter                                          | Document                                                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `openai`            | OpenAI Chat Completions                          | [openai](openai.md)                                                                                                                                                                                                            |
| `azure-openai`      | deployment path, `api-version`, `api-key` header | [azure-openai](azure-openai.md)                                                                                                                                                                                                |
| `openai-compatible` | OpenAI with a preset (`options.preset`)          | [openrouter](openrouter.md), [deepseek](deepseek.md), [groq](groq.md), [together](together.md), [fireworks](fireworks.md), [mistral](mistral.md), [xai](xai.md), [cerebras](cerebras.md), [ollama](ollama.md), [vllm](vllm.md) |
| `anthropic`         | Messages API                                     | [anthropic](anthropic.md)                                                                                                                                                                                                      |
| `gemini`            | generateContent / streamGenerateContent          | [gemini](gemini.md)                                                                                                                                                                                                            |
| `mock`              | fake provider for testing                        | [mock](mock.md)                                                                                                                                                                                                                |

## Adding a new compatible provider (config only)

`type: openai-compatible`, `baseUrl` (up to `/v1`), and if needed in `options`:

- `maxTokensField`: `max_tokens` (default) or `max_completion_tokens`
- `supportsStreamOptions`: `false` if the server rejects `stream_options`
- `headers`: additional fixed headers

---

<a id="persian"></a>

# Providerها

| نوع (`type`)        | آداپتر                                        | سند                                                                                                                                                                                                                            |
| ------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `openai`            | OpenAI Chat Completions                       | [openai](openai.md)                                                                                                                                                                                                            |
| `azure-openai`      | مسیر deployment، `api-version`، هدر `api-key` | [azure-openai](azure-openai.md)                                                                                                                                                                                                |
| `openai-compatible` | OpenAI با preset (`options.preset`)           | [openrouter](openrouter.md)، [deepseek](deepseek.md)، [groq](groq.md)، [together](together.md)، [fireworks](fireworks.md)، [mistral](mistral.md)، [xai](xai.md)، [cerebras](cerebras.md)، [ollama](ollama.md)، [vllm](vllm.md) |
| `anthropic`         | Messages API                                  | [anthropic](anthropic.md)                                                                                                                                                                                                      |
| `gemini`            | generateContent / streamGenerateContent       | [gemini](gemini.md)                                                                                                                                                                                                            |
| `mock`              | provider ساختگی برای تست                      | [mock](mock.md)                                                                                                                                                                                                                |

## افزودن provider سازگار جدید (فقط config)

`type: openai-compatible`، `baseUrl` (تا `/v1`)، و در صورت نیاز در `options`:

- `maxTokensField`: `max_tokens` (پیش‌فرض) یا `max_completion_tokens`
- `supportsStreamOptions`: `false` اگر سرور `stream_options` را رد می‌کند
- `headers`: هدرهای ثابت اضافه

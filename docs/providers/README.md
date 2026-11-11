[English](README.md) · [فارسی](README.fa.md)

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

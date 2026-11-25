---
'@dirouter/translator': minor
'@dirouter/contracts': minor
'@dirouter/gateway': minor
'@dirouter/mock-provider': minor
---

Codex's `apply_patch` works with non-GPT models (card 31.2). On the Responses API, a `custom` tool (free-form input, e.g. Codex's `apply_patch` with its Lark grammar) is carried as a function taking `{input}` with the grammar in its description, and OpenAI's built-in `apply_patch` tool as a function taking the file operation. The model's call comes back as `custom_tool_call` (streamed with `response.custom_tool_call_input.delta`/`.done`) or `apply_patch_call`, and replayed calls and their outputs (`custom_tool_call_output`, `apply_patch_call_output`) become ordinary tool calls and results, so Claude, Gemini and any other model can edit files for Codex. The mock provider takes the input of its tool call from `tool_input_b64`.

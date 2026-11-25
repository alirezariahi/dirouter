---
'@dirouter/translator': minor
'@dirouter/providers': minor
'@dirouter/contracts': minor
'@dirouter/gateway': minor
'@dirouter/control-api': minor
'@dirouter/dashboard': minor
'@dirouter/db': minor
---

Parameter policy per model and alias, and `drop_params` (card 31.4). A request policy takes `defaults`, `overrides`, `drop` and `unsupported`: portable names (`temperature`, `top_p`, `top_k`, `max_tokens`, `seed`, `stop`, `reasoning_effort`, `parallel_tool_calls`) act on the request in every format, any other name is a field of the provider's own body (dotted for nested ones). What a policy did is logged and returned in `x-dirouter-params`. A parameter the target cannot take (listed as unsupported, or one the translator cannot carry, such as `seed` to Anthropic, `top_k` to OpenAI or a client's own extras to another API) is dropped by default and answered with a 400 that names it when `drop_params` is off, set per organization (also on the Organization page) and overridden per request by the `x-dirouter-drop-params` header or the body's `drop_params`. Translators now report such parameters instead of dropping them silently.

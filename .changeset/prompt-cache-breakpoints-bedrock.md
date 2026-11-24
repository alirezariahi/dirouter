---
'@dirouter/contracts': minor
'@dirouter/translator': minor
'@dirouter/providers': minor
'@dirouter/gateway': minor
'@dirouter/mock-provider': minor
---

Prompt caching everywhere: `cache_control` breakpoints, with their TTL, are now kept on system
blocks, tools, text, images, documents, `tool_use` and `tool_result` (before, only on text), and
Bedrock gets them as Converse `cachePoint` blocks, including Anthropic's top-level automatic
caching. Claude Code through a Bedrock provider now reads from the prompt cache. Bedrock usage is
fixed to count cache reads and writes in the total input, as Converse reports them apart. The mock
provider simulates prompt caching on its Bedrock route.

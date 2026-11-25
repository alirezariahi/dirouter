---
'@dirouter/translator': minor
'@dirouter/contracts': minor
'@dirouter/gateway': minor
'@dirouter/control-api': minor
'@dirouter/dashboard': minor
'@dirouter/db': minor
'@dirouter/mock-provider': minor
---

Automatic prompt-cache breakpoints (card 31.3). Models and aliases have a request policy (`requestPolicy`, also in the model and alias editors); with `autoCache`, a request to an Anthropic or Bedrock model that carries no `cache_control` of its own gets breakpoints on the last tool, the last system block, the last message and the turn the previous request ended with (at most four, optional `autoCacheTtl`), so OpenAI-format clients read the cache from their second turn. A request with its own breakpoints is sent unchanged. The Cost page shows the provider's prompt cache: tokens read and written, the saving of the reads, the extra cost of the writes and the net saving (`GET stats/cache` → `promptCache`). The mock provider caches on its Anthropic route with Anthropic's rules.

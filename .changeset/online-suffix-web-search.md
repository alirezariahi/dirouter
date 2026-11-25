---
'@dirouter/gateway': patch
'@dirouter/mock-provider': patch
---

The `:online` model suffix now uses the gateway's own web search: the search is rate limited, budgeted and billed under the caller's key, and the suffix is refused with 400 `web_search_unavailable` when web search is off.

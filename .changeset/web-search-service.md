---
'@dirouter/contracts': minor
'@dirouter/gateway': minor
'@dirouter/mock-provider': minor
---

Web search and web fetch as a service: `POST /v1/search` across SearXNG (self-hosted), Brave and Tavily with fallback and a result cache, and `POST /v1/fetch`, SSRF-safe and bounded in size and time. Online mode (`web_search_options`, `plugins: [{ id: "web" }]`, and a hook for the `:online` suffix) gives a model without native search the results and answers with the sources; Claude Code's `web_search` server tool works with non-Anthropic models. Every search and fetch is its own usage event with its own price, so its cost shows separately in usage (card 30.8).

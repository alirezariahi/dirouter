# Web search and web fetch (card 30.8)

The gateway offers web search and page fetching as a service, so any model can work with current
information and coding tools keep their `web_search` tool when the model behind them is not an
Anthropic one.

## Backends

| Backend             | Configured with                                               | Notes                                                     |
| ------------------- | ------------------------------------------------------------- | --------------------------------------------------------- |
| SearXNG (self-host) | `WEB_SEARCH_SEARXNG_URL`                                      | The instance must allow `format=json` (`search.formats`). |
| Brave Search        | `WEB_SEARCH_BRAVE_API_KEY` (`WEB_SEARCH_BRAVE_URL` for tests) |                                                           |
| Tavily              | `WEB_SEARCH_TAVILY_API_KEY` (`WEB_SEARCH_TAVILY_URL`)         |                                                           |

Backends are tried in `settings.webSearch.order` (default SearXNG, Brave, Tavily); a backend
that answers with an error or does not answer in 8 seconds hands over to the next one. A
backend without configuration is skipped. See [env-reference.md](../env-reference.md).

## Settings

`settings.webSearch` in the gateway settings (Config page):

| Field             | Default                        | Meaning                                                   |
| ----------------- | ------------------------------ | --------------------------------------------------------- |
| `enabled`         | `true`                         | Switches search, fetch and online mode off when `false`.  |
| `order`           | `["searxng","brave","tavily"]` | Backend order for fallback.                               |
| `maxResults`      | `5`                            | Results per search (at most 20).                          |
| `cacheTtlSeconds` | `3600`                         | Identical searches come from the cache (Valkey); 0 = off. |
| `searchPriceUsd`  | `0.005`                        | Price per search.                                         |
| `fetchPriceUsd`   | `0.001`                        | Price per fetch.                                          |
| `fetchMaxBytes`   | `2097152`                      | Largest page read; the rest is dropped (`truncated`).     |
| `fetchTimeoutMs`  | `10000`                        | Deadline of one fetch, redirects included.                |

## `POST /v1/search`

```bash
curl https://api.example.com/v1/search -H "authorization: Bearer $DIROUTER_KEY" \
  -H 'content-type: application/json' -d '{ "query": "DiRouter release notes", "max_results": 3 }'
```

```json
{
  "object": "web_search",
  "query": "DiRouter release notes",
  "backend": "searxng",
  "cached": false,
  "results": [{ "title": "…", "url": "https://…", "snippet": "…", "published": "…" }],
  "usage": { "searches": 1, "cost_usd": "0.00500000" }
}
```

## `POST /v1/fetch`

```bash
curl https://api.example.com/v1/fetch -H "authorization: Bearer $DIROUTER_KEY" \
  -H 'content-type: application/json' -d '{ "url": "https://example.com/post", "max_bytes": 65536 }'
```

The answer has `url` (after redirects), `status`, `content_type`, `title`, `content` (readable
text: scripts, styles and tags removed), `bytes`, `truncated` and `usage`.

- **SSRF**: in production the address and every redirect target must be public: private,
  loopback, link-local and metadata addresses are refused (403) when connecting, so a name that
  resolves to a private address later (DNS rebinding) is caught too. This applies to every
  organization, the platform one included, since the address comes from an API caller.
- Only `http` and `https`, no credentials in the URL (400); at most five redirects.
- Text types only (HTML, plain text, JSON, XML); anything else is 415.
- Bounded in time (`fetchTimeoutMs`, 504) and size (`fetchMaxBytes` or the smaller `max_bytes`).

## Online mode

A chat request that asks for web search gets search results for its last user message, and the
answer carries the sources:

- OpenAI chat: `"web_search_options": {}` (OpenAI's own field; `search_context_size` `low` means 3
  results, `high` 10) or `"plugins": [{ "id": "web", "max_results": 3 }]` (OpenRouter's field). The
  results are given to the model as a system message with numbered sources, and the answer has
  OpenAI `url_citation` annotations on `choices[].message.annotations`. The header
  `x-dirouter-web-search` names the backend.
- The `:online` model suffix is the same mode (card 31.5 calls the hook below).
- A stream request is answered as a stream once the model's answer is complete.

## Claude Code and the `web_search` server tool

Claude Code's WebSearch sends Anthropic's server tool (`{"type": "web_search_20250305", …}`). When
the request's model is served by an Anthropic provider, the tool goes to Anthropic unchanged. For
any other model the gateway runs it:

1. The server tool becomes a function tool `web_search(query)`.
2. Each time the model calls it (up to the tool's `max_uses`, at most 10) the gateway searches
   and gives the model the results.
3. The answer has the blocks the Anthropic API returns: `server_tool_use`,
   `web_search_tool_result` (with `web_search_result` items: `title`, `url`, `page_age`) and the
   model's text, plus `usage.server_tool_use.web_search_requests`. Streams get the same blocks as
   Messages API events.

## Usage and cost

Every search and fetch is its own usage event, with inbound API `web.search` or `web.fetch`, model
`web_search:<backend>` or `web_fetch`, and its own price, so search cost is visible separately in
the request log and cost reports. A search made for a chat request has the request id
`<chat request id>:web_search:<n>`; the model calls keep the chat request id (later rounds of a
search loop get `.r<n>`). An answer from the cache costs nothing. Searches and fetches count
against the key's rate limit and budgets, and a prepaid wallet is charged.

## Hook for the `:online` suffix (card 31.5)

```ts
// apps/gateway/src/web/service.ts, reachable as deps.web on ProxyDeps
deps.web?.serveOnline(api: 'openai.chat' | 'anthropic.messages', req: FastifyRequest, reply: FastifyReply): Promise<unknown>
```

`req.body` must carry the model without the suffix. The method authenticates the key, searches,
injects the results, calls the model through the gateway's own route and replies (JSON or SSE).

## Testing without the internet

The mock provider serves all three backends and test pages under `/web/…`
([mock-provider.md](../mock-provider.md)); Compose dev points the gateway at them.

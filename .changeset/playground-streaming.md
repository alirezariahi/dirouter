---
'@dirouter/dashboard': minor
'@dirouter/control-api': minor
---

The playground streams: up to four models side by side, each with its time to first token, tool
calls, the gateway's `x-dirouter-*` headers, latency, tokens and cost. Requests can carry tool
definitions, an image, `max_tokens`, `top_p`, `reasoning_effort` and `response_format`. New
`POST /orgs/:orgId/playground/stream` answers `text/event-stream` (`meta`, `ttft`, `chunk`,
`error`, `end`).

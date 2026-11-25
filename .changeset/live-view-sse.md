---
'@dirouter/gateway': minor
'@dirouter/control-api': minor
'@dirouter/contracts': minor
'@dirouter/dashboard': minor
---

Live view over SSE: the gateway publishes each finished request (metadata only) on its
organization's Valkey channel, control-api streams it at `GET /orgs/:orgId/stats/live/stream`, and
the Live page shows it as soon as the gateway finishes the request. When the stream drops or cannot
be opened, the page polls every second and keeps reconnecting.

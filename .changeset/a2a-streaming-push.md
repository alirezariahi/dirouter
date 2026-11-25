---
'@dirouter/gateway': minor
'@dirouter/mock-provider': minor
---

A2A 1.0 complete: `SendStreamingMessage` and `SubscribeToTask` over SSE (v0.3 `message/stream`, `tasks/resubscribe`), with the model's answer streamed as artifact updates and events shared between replicas through Valkey; `returnImmediately` and cancellation of running tasks; push notification config CRUD with webhooks guarded against SSRF and called with an ES256 signature over the exact body (public key at `/.well-known/jwks.json`), the configured `Authorization` and `X-A2A-Notification-Token`; Major.Minor `A2A-Version` negotiation from the header or query parameter. The Agent Card now advertises streaming and push notifications (card 28.2).

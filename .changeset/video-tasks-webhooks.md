---
'@dirouter/gateway': minor
'@dirouter/contracts': minor
'@dirouter/model-catalog': minor
'@dirouter/providers': minor
'@dirouter/mock-provider': minor
'@dirouter/control-api': minor
'@dirouter/dashboard': minor
'@dirouter/db': minor
---

Video generation as async tasks with signed webhooks (card 30.6).

- `/v1/videos` (create, retrieve, list, content, delete) is compatible with OpenAI's Videos API and the official SDKs; `POST /v1/videos/{id}/cancel` stops a running task.
- Adapters for the OpenAI Videos shape (OpenAI-compatible providers; OpenAI's own Sora API is shut down), Google Veo on the Gemini API and fal's queue; a model offers video with the new `video` capability.
- Tasks are followed by the gateway's job poller; only a completed task is billed, per generated second (`perSecondUsd`) and per request (the new `perRequestUsd` price, `request_price` column); failed and cancelled tasks cost nothing and release the wallet hold.
- `webhook_url` on a video or a batch sends an OpenAI-style event when it ends, signed per Standard Webhooks with the organization's secret (`GET /v1/webhooks/secret`), through the SSRF guard, retried for about two hours.
- The dashboard's model form has the video capability and the per-request price; the mock provider serves OpenAI videos, Veo operations and a fal queue, and its webhook sink can fail on purpose.

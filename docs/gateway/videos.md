[English](videos.md) · [فارسی](videos.fa.md)

# Video generation and async tasks (card 30.6)

Video generation takes minutes, so it is an async task: the client starts it, follows its status and downloads the result when it is done. DiRouter serves OpenAI's Videos API, so the official OpenAI SDKs work by changing `baseURL` only, and runs the task on any provider with a video adapter. The same key, rate limits, budgets, wallet and usage accounting apply as for other requests, and only a task that completes is billed.

| Endpoint                      | What it does                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| `POST /v1/videos`             | Start a task: `model` (default `sora-2`), `prompt`, `seconds`, `size`, `webhook_url` |
| `GET /v1/videos/{id}`         | Status and progress; also refreshes from the provider                                |
| `GET /v1/videos/{id}/content` | The finished video (`variant`: `video`, `thumbnail`, `spritesheet`)                  |
| `POST /v1/videos/{id}/cancel` | Stop a running task (DiRouter extension); it ends as `failed` with code `cancelled`  |
| `DELETE /v1/videos/{id}`      | Cancel if running, delete at the provider and forget the task                        |
| `GET /v1/videos`              | List (`limit` up to 100, `after`)                                                    |
| `GET /v1/webhooks/secret`     | The organization's webhook signing secret (DiRouter extension)                       |

```python
from openai import OpenAI

client = OpenAI(base_url="https://api.example.com/v1", api_key=DIROUTER_KEY)
video = client.videos.create_and_poll(model="sora-2", prompt="A red fox in the snow", seconds="8")
if video.status == "completed":
    client.videos.download_content(video.id).write_to_file("fox.mp4")
```

A video object has `status` (`queued`, `in_progress`, `completed`, `failed`), `progress` (0–100), `seconds`, `size` and, for a failed task, `error: {code, message}`.

## Providers

A model is offered for video when its **Video generation** capability is on (`capabilities.video`) and its provider type has a video adapter. Routing and fallback at start work as for other requests: a target whose provider fails with a server error or rate limit is skipped; a running task stays on its provider.

| Provider type                         | Upstream API                                                                                                                                                                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openai`, `openai-compatible`, `mock` | OpenAI Videos shape (`/videos`): status, content with every variant, cancel as delete. OpenAI shut its own Sora API down on 2026-09-24; the adapter serves providers and gateways that still offer this shape.                                                      |
| `gemini`                              | Google Veo on the Gemini API: `models/<model>:predictLongRunning`, then the operation until `done`; the video is downloaded from the file URI it returns (the key is sent only to the provider's own origin). Cancel calls the operation's `:cancel`. No thumbnail. |
| `fal`                                 | fal's queue: the request goes to `https://queue.fal.run/<model>` (or the provider's `options.queueBaseUrl`); status, result and cancel use the URLs fal returns, only on the queue's origin. The video is downloaded from fal's CDN without the key. No thumbnail.  |

`seconds` defaults to 4 on the OpenAI shape, 8 on Veo and 5 on fal; `size` (`1280x720`, `720x1280`, …) becomes `aspectRatio` on Veo and `aspect_ratio` on fal.

## Price

Set the model's **Audio or video / second** price (`perSecondUsd`) and, if the provider charges per video, **Per request** (`perRequestUsd`). A completed task records one usage event (`inboundApi: "openai.videos"`, `requestId` = the video id) with `media: {seconds, requests: 1}`; the seconds are the length the provider reports, or the requested length. The sale price (multiplier and customer group) applies as for any request.

A task that fails or is cancelled records an error event with zero cost. At start the wallet holds the task's worst case (requested seconds × price + per-request price on the most expensive target) for up to six hours; the hold becomes the real charge, or is released, when the task ends.

## Webhooks

Pass `webhook_url` when starting a task (or a batch, see [Batch API](batch.md)) and DiRouter POSTs an event when it ends, in OpenAI's webhook event format:

```json
{
  "id": "evt_…",
  "object": "event",
  "created_at": 1764072000,
  "type": "video.completed",
  "data": { "id": "video_…" }
}
```

Types: `video.completed`, `video.failed`, `batch.completed`, `batch.failed`, `batch.cancelled`, `batch.expired`.

- **Signature**: [Standard Webhooks](https://www.standardwebhooks.com/), the scheme OpenAI uses. Headers `webhook-id`, `webhook-timestamp` and `webhook-signature: v1,<base64 HMAC-SHA256 of "<id>.<timestamp>.<body>">`. The secret (`whsec_…`) belongs to the organization: read it with any of its keys at `GET /v1/webhooks/secret`. It is derived from `MASTER_KEY`, so rotating `MASTER_KEY` rotates it. The OpenAI SDK verifies it: `client.webhooks.unwrap(body, headers, secret)`.
- **Retries**: at least once. A network error, a timeout (10 s) or any non-2xx answer is retried after 5 s, 30 s, 2 min, 10 min, 30 min and 1 h; then the event is dropped and logged. Redirects are not followed. Use `webhook-id` to ignore duplicates.
- **SSRF**: the URL must be `http` or `https` without credentials; in production a customer organization's webhook must be `https` and resolve to a public address, checked again when connecting.

## How it runs

Tasks are records in Valkey followed by the gateway's job poller every `JOBS_POLL_INTERVAL_MS`, like batches ([ADR-0007](../adr/0007-job-state-in-valkey.md)); webhook deliveries are records in the same store, so a retry survives a restart. Task records are kept seven days; the provider may delete the video itself sooner (OpenAI keeps content for a limited time).

## Not supported

- `input_reference` (image or video input), remix, edit and extend.
- Other video providers (Runway, Luma, Vertex AI Veo) yet; a provider plugin or a new adapter in `packages/providers/src/video.ts` can add one.

# Request bodies, payload view and replay

> Code: `apps/gateway/src/body-capture.ts`, `packages/contracts/src/request-body.ts`, `redactForStorage` in `packages/contracts/src/guardrail-engine.ts`, `apps/worker/src/request-bodies.ts`, `apps/control-api/src/bodies` (card 24.1). Dashboard: **Logs** (payload in the request detail, capture levels below the table) and **Playground** (replay).

The request log records what happened to a request (model, provider, status, tokens, cost). To debug one request without guessing its content, the gateway can also keep its body and its answer. This is **off by default**.

## Capture level

| Level      | What is stored                                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `none`     | Nothing (default).                                                                                                                                                                                |
| `metadata` | The shape only: requested model, `stream`, the parameter names the client set (never their values), message count per role, tool names, request and answer size in bytes, finish reason. No text. |
| `full`     | Everything in `metadata`, plus the request JSON as the client sent it and the answer JSON, both redacted and cut at the size cap, plus a replay draft for the playground.                         |

A level is set for the **organization**, a **project** or a **virtual key**. The most specific one wins: the key's own level, else its project's, else its organization's, else the instance default. The instance default is `settings.bodyCapture.defaultLevel` in the gateway settings (OWNER only, **Config** page); without it the legacy `settings.logBodies: true` means `full`, and otherwise `none`.

Levels are changed in the dashboard (**Logs**, "Request body capture") or through the API below. Every change is written to the audit log (`body_capture.updated`) and published in the config snapshot (`bodyCapture`); the gateway applies it once it has loaded that snapshot.

## Redaction and size cap

Before a body leaves the gateway:

1. Every string in the request and in the answer goes through the **`redact` guardrail policies** that apply to the key (organization-wide, project or key policies, matching stage). A policy whose action is `redact` masks its matches with `[REDACTED]` in storage, exactly as in live traffic. `block` and `flag` policies do not change what is stored.
2. Credentials (the patterns of the `secret` guardrail type: provider keys, DiRouter keys, JWTs, private keys) are **always** masked, whatever the policies say.
3. Each part (request and answer) is cut at `settings.bodyCapture.maxBytes` (default 65,536 bytes, 1 KiB to 1 MiB) on a character boundary and marked as truncated. A truncated request cannot be shown as JSON and is shown as text.

The number of masked matches is stored with the body. Redaction runs on the parsed structure, before the cut, so a cut never leaves half of a match behind.

A streamed answer is stored as the one JSON answer it adds up to (in the client's API format) and marked `streamed`. It is rebuilt from what the provider sent, before stream guardrails; `redact` policies are applied to it again by step 1. When a stream breaks off before it finishes, only the request is stored. Error answers (4xx and 5xx from the gateway) are stored as the client received them.

Only the chat-style endpoints (`/v1/chat/completions`, `/v1/messages`, `/v1/responses`, Gemini `generateContent`) are captured. Embeddings, images, speech and transcription are not.

## Storage path

```
gateway ──(response closed)──▶ BullMQ "request-bodies" ──▶ worker ──▶ request_bodies (daily partitions)
```

- Bodies **never** travel with usage events. They have their own queue (`request-bodies`), so a large prompt never adds volume to the `usage` queue and billing never waits for a body.
- Sending is best effort: when Valkey is unavailable, or more than 200 bodies are waiting to be queued, the body is dropped. The request itself is never affected and its usage event is unaffected.
- The worker writes each body once (`ON CONFLICT DO NOTHING` on `(request_id, created_at)`); `created_at` is the same instant as the request's `request_log` row.
- `request_bodies` is partitioned **by day** in the `partitions` schema. The worker creates today's and the next three days' partitions every hour (`body-partitions`) and drops whole days older than `REQUEST_BODY_RETENTION_DAYS` (default 7) every day at 03:27 UTC (`body-retention`). This retention is independent of `REQUEST_LOG_RETENTION_MONTHS`: bodies usually go long before the log entry. See [database](../database.md).

## Viewing a payload

The **`logs:bodies`** permission is required for everything here. It is not a `:read` permission: OWNER and ADMIN have it, MEMBER and VIEWER do not unless a custom role adds it. Without it the Log Explorer shows no payload section and never asks for a body; `usage:read` alone does not reveal one.

| Route                            | Permission    | What                                                                                                                        |
| -------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `GET /orgs/:orgId/logs/:id/body` | `logs:bodies` | The stored body of a request; 404 when nothing was captured or it has expired                                               |
| `GET /orgs/:orgId/body-capture`  | `logs:bodies` | Explicit levels of the organization, the instance default and the size cap                                                  |
| `PUT /orgs/:orgId/body-capture`  | `logs:bodies` | `{scope: organization \| project \| key, scopeId, level: none \| metadata \| full \| inherit}`; `inherit` removes the level |

A body is only returned inside its own organization; a project or key of another organization is "not found".

## Replay

A `full` body carries a replay draft: the system text, every earlier user and assistant turn as plain text, the last user message as the prompt, and `max_tokens` and `temperature`. **Replay in playground** opens the playground with this conversation; any model can be picked, and the request goes through the gateway with the user's own key like any playground call. Images, tool calls and tool results cannot be replayed and are left out; the playground says so. The draft is redacted like the body, so a masked value is replayed masked.

The draft is handed over through the browser's `sessionStorage` and read once, so the prompt never appears in a URL.

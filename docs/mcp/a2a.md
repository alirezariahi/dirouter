# A2A: Agent Card, JSON-RPC, streaming and push notifications

Cards 20.3 and 28.2 · code: `apps/gateway/src/a2a` (`agent.ts`, `push.ts`), fake agent and webhook recorder: `apps/mock-provider/src/a2a.ts`

The Agent2Agent protocol is spoken in two versions: **v1.0** (current) and **v0.3**. The wire format follows the method name. The `A2A-Version` header (or the `A2A-Version` query parameter) is read as Major.Minor, patch ignored: `1.0` and `0.3` are supported, anything else gets VersionNotSupportedError (`-32009`). An empty value means 0.3 per the spec, but since the method name decides the format, v1.0 clients that leave it out keep working. Answers carry `A2A-Version` with the version used.

|                | v1.0                                               | v0.3                                               |
| -------------- | -------------------------------------------------- | -------------------------------------------------- |
| send           | `SendMessage` (answer `{task}`)                    | `message/send` (the Task itself, `kind: "task"`)   |
| stream         | `SendStreamingMessage`                             | `message/stream`                                   |
| read           | `GetTask` `{id, historyLength?}`                   | `tasks/get`                                        |
| cancel         | `CancelTask`                                       | `tasks/cancel`                                     |
| subscribe      | `SubscribeToTask` `{id}`                           | `tasks/resubscribe`                                |
| push config    | `Create/Get/List/DeleteTaskPushNotificationConfig` | `tasks/pushNotificationConfig/set/get/list/delete` |
| text part      | `{text}`                                           | `{kind: "text", text}`                             |
| role and state | `ROLE_USER`, `TASK_STATE_COMPLETED`                | `user`, `completed`                                |

## DiRouter as an agent

- **Agent Card:** `GET /.well-known/agent-card.json` (and `/.well-known/agent.json` for older clients), without authentication. `supportedInterfaces` lists `/a2a` with the `JSONRPC` binding for 1.0 and 0.3, Bearer authentication (the virtual key) is declared, and `capabilities` is `{streaming: true, pushNotifications: true}`. The address is built from Traefik's `X-Forwarded-*` headers.
- **Answering:** the message text is answered by the gateway's own `/v1/chat/completions` with the sender's key, so routing, fallback, rate limits, budgets, the wallet and usage logging apply exactly as for a normal request. The model comes from `metadata.model` (request or message) or the gateway setting `settings.a2a.defaultModel`. Without a model the task is `rejected` with a hint; a model error (for example no credit) makes it `failed`.
- **Tasks and conversations:** tasks and the history of each `contextId` stay in Valkey for a day (`a2a:task:*`, `a2a:ctx:*`). The next message with the same `contextId` continues the conversation (at most 40 messages). A task is visible only to its organization and project: another project gets TaskNotFound (`-32001`), and another project's `contextId` starts a fresh conversation.

### Task lifecycle (card 28.2)

`submitted` → `working` → `completed` / `failed`, or `rejected` (no model) or `canceled`.

- `SendMessage` waits for the answer by default. With `configuration.returnImmediately: true` (v0.3: `blocking: false`) it returns the submitted task at once and finishes it in the background; follow it with `GetTask`, `SubscribeToTask` or a push notification.
- `CancelTask` cancels a task that is still running (the model call is aborted on the replica that runs it, and a result arriving later is dropped); a finished task answers TaskNotCancelableError (`-32002`).

### Streaming

- `SendStreamingMessage` answers with `text/event-stream`. Every `data:` line is a JSON-RPC response with the request id whose `result` is a v1.0 `StreamResponse` with exactly one of `task`, `statusUpdate`, `artifactUpdate`:
  1. `{task}`, state `TASK_STATE_SUBMITTED`;
  2. `{statusUpdate}` `TASK_STATE_WORKING`;
  3. the answer as it streams from the model: `{artifactUpdate: {artifact: {artifactId: "<task>-answer", parts: [{text}]}, append, lastChunk}}`, the first chunk with `append: false`, the last with `lastChunk: true`;
  4. `{statusUpdate}` with the terminal state, after which the stream closes.

  v0.3 (`message/stream`) sends the same as the Task (`kind: "task"`), `{kind: "status-update", final}` and `{kind: "artifact-update", append, lastChunk}`. Refusals that can be known in advance (bad message, unknown task) come back as a plain JSON-RPC error instead of a stream. A comment line every 15 seconds keeps proxies from closing an idle stream. A client that disconnects ends its stream, not the task.

- `SubscribeToTask` streams a task that is still running, in the same format, starting with the Task in its current state. On a finished task it answers UnsupportedOperationError (`-32004`), as the spec requires. Events travel between replicas over Valkey pub/sub (`a2a:events:<task>`), so the subscription works on any replica.
- The proxy to external agents passes SSE answers through unchanged.

### Push notifications

A webhook is registered for a task with `CreateTaskPushNotificationConfig` (`{taskId, id?, url, token?, authentication?: {scheme, credentials?}}`; v0.3 nests it in `pushNotificationConfig` with `authentication.schemes`), or directly on a send with `configuration.taskPushNotificationConfig` (v0.3 `pushNotificationConfig`). At most 10 per task. `Get` and `List` (`{configs, nextPageToken}`) never return the credentials; `Delete` is idempotent. Configurations are stored with the task, encrypted with MASTER_KEY.

On every status change each webhook gets a `POST`:

|                             |                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| body                        | v1.0: `{statusUpdate}` for `working`, `{task}` (with the answer) for the terminal state; v0.3: the Task |
| `Content-Type`              | `application/a2a+json` (v1.0) or `application/json` (v0.3)                                              |
| `Authorization`             | `<scheme> <credentials>` from the configuration, as the spec requires                                   |
| `X-A2A-Notification-Token`  | the configuration's `token`, to check the notification belongs to it                                    |
| `X-DiRouter-Push-Signature` | compact JWS, ES256 (below)                                                                              |
| `A2A-Version`               | the configuration's version                                                                             |

Deliveries of one task go out in order, at least once: network errors, 429 and 5xx are retried after 0.5, 1 and 2 seconds, each attempt has 10 seconds, and redirects are not followed.

**Signature.** The JWS header has `alg: ES256`, `kid` and `jku` (`<agent>/.well-known/jwks.json`); the claims are `iss` (the agent URL), `aud` (the webhook URL), `taskId`, `iat`, `exp` (five minutes), `jti` and `request_body_sha256` (hex SHA-256 of the exact body). A receiver fetches `GET /.well-known/jwks.json` once (pin that URL rather than trusting `jku` blindly), checks the signature, that the body hash matches, that `aud` is its own URL, that `exp` has not passed, and drops repeated `jti`. The key is derived from MASTER_KEY (HKDF), so every replica signs with the same key without a new secret; rotating MASTER_KEY rotates it and changes `kid`.

**SSRF.** The URL must be http(s) without credentials in it. In production (`NODE_ENV=production`), for every organization except the platform organization, it must be https and resolve to a public address (the provider guard of card 22.3); this is checked when the configuration is created and again when connecting (DNS rebinding), and an IP literal is checked directly.

## External agents

An external agent is registered like an MCP server with transport `a2a` (`POST /orgs/:orgId/mcp/servers`, `url` the agent's JSON-RPC endpoint, `headers` encrypted for the agent's own key):

- `POST /a2a/agents/<slug>`: a JSON-RPC request (either version) with the agent's headers, the client's `A2A-Version` and, with `forwardIdentity`, the organization, project and key ids. Streaming answers are passed through.
- `GET /a2a/agents/<slug>/.well-known/agent-card.json`: the agent's card (first under its path, then the origin root) with `supportedInterfaces` rewritten to DiRouter and DiRouter's Bearer scheme. The agent's own address and authentication stay hidden.
- Key governance: the key's `mcpTools` allowlist allows the agent with `<slug>__*` (or `*`). An agent outside it gets 404 and is logged as `denied`.
- Log: every call goes to `mcp_tool_calls` with `tool = a2a:<method>` and the masked message text.

## Tests

- `apps/gateway/src/a2a/agent.test.ts`: the card, v1.0 `SendMessage`/`GetTask`/`CancelTask`, the v0.3 shape, conversation per context and project isolation, a rejected task without a model, unsupported versions, and the external agent proxy (key, identity, allowlist, log).
- `apps/gateway/src/a2a/streaming.test.ts`: the official A2A SDKs cannot be installed offline in the test environment, so the test carries a client written from the A2A 1.0 specification (Agent Card discovery, `A2A-Version`, SSE parsing, one `StreamResponse` member per event, Task first, `append`/`lastChunk`, end at a terminal state). With it: `SendStreamingMessage` streamed chunk by chunk, v0.3 `message/stream`, `SubscribeToTask` on a running and a finished task, `CancelTask` of a running task, a push notification arriving at a local webhook with `Authorization`, token and a signature verified against the JWKS (and failing for a changed body), retries of a failing webhook, config CRUD in both versions and per project, version negotiation, the external agent stream, subscribing across two gateways through Valkey (with `INTEGRATION_VALKEY_URL`), and private webhook addresses refused under the SSRF guard.
- e2e on compose: `node scripts/e2e/sprint-3.mjs 20.3` and `node scripts/e2e/sprint-4.mjs 28.2` (the stream through Traefik, and signed notifications at the mock's webhook recorder `/__hooks/<name>`, verified with the published key).

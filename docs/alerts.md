[English](alerts.md) · [فارسی](alerts.fa.md)

# Alerts and notification channels (card 16.2)

> Code: `apps/worker/src/alerts.ts` (evaluation and delivery), `apps/control-api/src/alerts` (CRUD and test message). Dashboard: **Alerts**.

The worker evaluates every enabled rule on a schedule (`ALERT_EVALUATE_INTERVAL_MS`, default 60 seconds). When a rule's value reaches its threshold an event is created and delivered to the rule's channel.

## Rules

| Type                 | Value compared with `threshold`                                             | Unit    |
| -------------------- | --------------------------------------------------------------------------- | ------- |
| `error_rate`         | share of failed requests in the window                                      | percent |
| `latency`            | p95 latency in the window                                                   | ms      |
| `budget`             | cost of the organization's requests in the window                           | USD     |
| `invalid_credential` | failed authentication probes in the window (needs health probes, card 12.3) | count   |

- `windowMinutes` is the look-back period; `silenceMinutes` is the minimum time between two notifications of the same rule.
- **Deduplication**: one event per rule per silence window, enforced by a unique `(rule, dedupKey)` index, so several worker replicas never notify twice.
- A rule with no traffic in its window is skipped, not fired.
- `error_rate`, `latency` and `budget` rules **require a threshold**; the API rejects them without one and the worker skips (never fires) a stored rule that has none. `invalid_credential` defaults to 1.
- **Delivery retries**: the silence window only starts once the notification was delivered. A failed delivery is retried on the following evaluation ticks, at most 5 attempts in total; the attempt count is kept in the event's `details.deliveryAttempts`.
- `breaker_open` and `queue_length` are **rejected by the API** with a validation error: breaker state and queue length are not stored where the worker can read them, so such a rule could never fire. Rules of these types stored by an older version are skipped.

## Channels

| Type       | `config`                 | Delivery                                                                                |
| ---------- | ------------------------ | --------------------------------------------------------------------------------------- |
| `webhook`  | `url`, optional `secret` | JSON `POST`; with a secret, the body is signed in `x-dirouter-signature: sha256=<hmac>` |
| `slack`    | `webhookUrl`             | Slack incoming webhook                                                                  |
| `telegram` | `botToken`, `chatId`     | Telegram Bot API `sendMessage`                                                          |
| `email`    | `webhookUrl`, `to`       | through an HTTP relay you provide; **direct SMTP is not implemented**                   |

Every channel has a **Send test message** button (`POST /orgs/:orgId/alerts/channels/:id/test`), which delivers a test notification immediately and reports the provider's answer.

### Secrets

Channel responses never contain secrets. `secret`, `botToken`, `webhookUrl` (and `url` for every type except `webhook`) are returned as `"***"`, together with `secretFields` (the names that are set) and `hasSecret`. On update, a secret that is omitted or sent back as `"***"` keeps its stored value; send `null` or an empty string to remove it. Changing the channel type drops the old type's secrets.

### Outbound URL policy

Channel URLs are called by the server, so they are restricted (control-api test message and worker delivery use the same rule):

- always: an absolute `http(s)` URL without embedded credentials; redirects are not followed;
- when `NODE_ENV=production`: `https` only, and every address the host resolves to must be public — loopback, private, link-local (including the cloud metadata address `169.254.169.254`), carrier-grade NAT and multicast ranges are refused;
- in development private hosts are allowed, because the dev stack posts to local mock services.

## Events

`GET /orgs/:orgId/alerts/events` lists events with delivery status and error; `POST …/events/:id/ack` acknowledges one. The dashboard list refreshes every 30 seconds.

## API

`/orgs/:orgId/alerts/channels`, `/rules`, `/events` with permissions `alerts:read` and `alerts:write`. Creating, updating and deleting channels and rules is written to the audit log (names and changed field names only, never config values).

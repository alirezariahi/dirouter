# Alerts and notification channels (cards 16.2 and 24.2)

> Code: `apps/worker/src/alerts.ts` (evaluation and delivery), `apps/control-api/src/alerts` (CRUD and test message). Dashboard: **Alerts**.

The worker evaluates every enabled rule on a schedule (`ALERT_EVALUATE_INTERVAL_MS`, default 60 seconds). When a rule's value reaches its threshold an event is created and delivered to the rule's channel.

## Rules

| Type                   | Value compared with `threshold`                                                                                                            | Unit              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| `error_rate`           | share of failed requests in the window                                                                                                     | percent           |
| `latency`              | p95 latency in the window                                                                                                                  | ms                |
| `budget`               | cost of the organization's requests in the window                                                                                          | USD               |
| `invalid_credential`   | failed authentication probes in the window (needs health probes, card 12.3)                                                                | count             |
| `breaker_open`         | circuit breakers of the organization's providers and models that are open, or were open during the window                                  | count             |
| `queue_length`         | jobs waiting in the usage queue (waiting, delayed and prioritized)                                                                         | jobs              |
| `upstream_balance_low` | lowest balance of the organization's provider accounts; fires **at or below** the threshold ([upstream-balances.md](upstream-balances.md)) | provider currency |

- `windowMinutes` is the look-back period; `silenceMinutes` is the minimum time between two notifications of the same rule.
- **Deduplication**: one event per rule per silence window, enforced by a unique `(rule, dedupKey)` index, so several worker replicas never notify twice.
- A rule with no traffic in its window is skipped, not fired.
- `error_rate`, `latency`, `budget`, `queue_length` and `upstream_balance_low` rules **require a threshold**; the API rejects them without one and the worker skips (never fires) a stored rule that has none. `invalid_credential` and `breaker_open` default to 1.
- **Delivery retries**: the silence window only starts once the notification was delivered. A failed delivery is retried on the following evaluation ticks, at most 5 attempts in total; the attempt count is kept in the event's `details.deliveryAttempts`.

### Breaker state (`breaker_open`)

The gateway keeps its breakers in memory and syncs replicas over Valkey pub/sub (cards 5.5 and 5.6). Since card 24.2 every breaker transition is also written to the Valkey hash `dirouter:breakers`: the field is `provider:<id>` or `model:<id>`, the value `{ state, at, reopensAt }`. An open or half-open breaker is stored; a breaker that closes, or a manual reset from the Health page, removes its field. The worker reads the hash, keeps the entries of the rule's organization (providers and models it owns) and counts those whose last transition or reopen time falls inside the window. An entry left behind by a replica that died while its breaker was open therefore stops counting after one window. Writing the hash is best effort, like the pub/sub sync: a Valkey outage never affects the breaker itself.

The event details list the breakers (`details.breakers`), and email, Slack and Telegram messages name them.

### Usage queue (`queue_length`)

The worker reads the size of the BullMQ `usage` queue (waiting, delayed and prioritized jobs; not the ones being processed). The queue belongs to the deployment, so it is operator information: only the **platform organization** can create a `queue_length` rule (other organizations get **403**), and the worker skips such a rule of any other organization (`not_platform_organization`), including ones created before this rule. A rising value means the worker cannot keep up with the gateway's usage events, and the gateway's outbox starts to grow behind it.

## Channels

| Type       | `config`                    | Delivery                                                                                        |
| ---------- | --------------------------- | ----------------------------------------------------------------------------------------------- |
| `webhook`  | `url`, optional `secret`    | JSON `POST`; with a secret, the body is signed in `x-dirouter-signature: sha256=<hmac>`         |
| `slack`    | `webhookUrl`                | Slack incoming webhook                                                                          |
| `telegram` | `botToken`, `chatId`        | Telegram Bot API `sendMessage`                                                                  |
| `email`    | `to`, optional `webhookUrl` | over SMTP (`SMTP_URL` on the worker, TLS); with a `webhookUrl`, through that HTTP relay instead |

`to` takes one or more plain addresses separated by commas (at most 20). The SMTP settings are the deployment's, never the channel's: `SMTP_URL` and `SMTP_FROM` on the worker (alerts) and the control-api (test message, invitations, email verification), described in the [environment reference](env-reference.md). `smtps://` uses implicit TLS, `smtp://` STARTTLS, which is required in production; certificates are always verified. Without `SMTP_URL` an email channel without a relay reports `SMTP is not configured` as its delivery error.

In development the worker and the control-api send to Mailpit (`smtp://mailpit:1025`); read the messages at `http://mail.localhost` or `http://127.0.0.1:58025`.

Every channel has a **Send test message** button (`POST /orgs/:orgId/alerts/channels/:id/test`), which delivers a test notification immediately and reports the provider's answer. Because it goes out through the deployment's SMTP server (or to an admin-entered URL), it is limited:

- one test per channel per minute and ten per organization per hour, counted in Valkey across replicas; beyond that **429** with `Retry-After`. Without Valkey no test is sent (503);
- a test of an `email` channel needs a verified email address of the person sending it (with a management token, the token's creator): otherwise **403 `email_not_verified`**;
- the title, and so the email subject, is fixed (`[DiRouter] Test alert from DiRouter`); the channel name and other tenant text are not put into it.

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

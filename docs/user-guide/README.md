[English](README.md) · [فارسی](README.fa.md)

# Dashboard user guide

This guide explains the current workflow of the Persian dashboard. The screenshots were taken on November 8, 2026 from a local development install with mock data; they contain no real credential or complete virtual key. Names and numbers in the images are samples, not production data.

## Getting started and orientation

- **Empty install:** open `/setup`. Step 1 creates the organization and the OWNER; step 2 optionally adds a provider with a credential; step 3 creates the `Default` project and the first virtual key. The password must be at least 10 characters. Copy the key right away and keep it safe; the full value cannot be recovered later.
- **Existing install:** `/login` asks for email and password. Sign out from the account menu. After a reload, the session is recovered from the refresh cookie, and it is revoked on sign-out or password change.
- The sidebar leads to Overview, Providers, Virtual keys, Models and Combos, Request logs, Health, Organization and the connection guides. The user account is available from the top bar and the `/account` path.
- The language (Persian/English), the calendar (Solar Hijri/Gregorian) and the theme (system/light/dark) can be changed. `⌘K` opens command search.
- The 24-hour / 7-day / 30-day range is shared between Overview and Keys. Overview pages refresh every 30 seconds, and health every 5 seconds.

![Dashboard sign-in](screenshots/login.png)

## Concepts: from provider to request

```text
Organization
├─ Provider ── Credential (several weighted upstream keys)
├─ Model ───── upstream name + price + context + capabilities
├─ Combo ───── several Models + strategy + retry/fallback
├─ Alias ───── stable client name → Model or Combo
└─ Project ─── Virtual Key ── allowed models + limit + budget + expiry/IP
```

| concept                     | meaning and practical note                                                                                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Provider**                | a connection to OpenAI, Anthropic, Gemini, Azure OpenAI or an OpenAI-compatible API. It has a base URL, proxy, timeouts and a concurrency cap.                                                                 |
| **Credential**              | the upstream secret inside a provider. Several weighted credentials are used for load/quota distribution and fallback. Only the last four characters are shown masked; the full value cannot be recovered.     |
| **Model**                   | a mapping of a public name to the provider's `upstreamModel`. It has a price per million tokens, context, max output and capabilities.                                                                         |
| **Combo**                   | a set of models. `priority` is a fixed order, `weighted` is weighted selection, and `round-robin` rotates per combo+key. `fallbackOn` determines which error class goes to the next candidate.                 |
| **Alias**                   | the name the client sees, pointing to a model or combo. When the alias target changes, the client's API name stays the same.                                                                                   |
| **Virtual Key**             | a `dr-…` key for the client app; it is different from a provider credential. Only the HMAC and the prefix are stored; the full value is shown once, on create or rotate.                                       |
| **RPM / TPM / Concurrency** | request/token caps per minute and concurrent requests. Key, project and team limits are applied together; a rejection is 429 with `Retry-After`.                                                               |
| **Budget**                  | a daily or monthly dollar or token cap. The period is in UTC. A started request finishes; after its cost is recorded, the next request may get 429 `budget_exceeded`.                                          |
| **Circuit breaker**         | after repeated health errors, a provider or model is temporarily `open`; `half_open` is limited testing, and `closed` is normal. Cooldown/lockout applies to a credential, not necessarily the whole provider. |

For details: [routing](../concepts/routing.md), [limits and budget](../concepts/limits.md), [keys](../control-api/keys.md).

## Overview — `/`

Compares the KPIs for requests, tokens, cost, error rate, p50/p95, TTFT and active keys with the previous period. Switch the chart between requests, cost and errors. Clicking a column or a row of an expensive model, key or project opens the Request Log with the same range and filter. The provider breaker status is summarized at the bottom of the page.

**Reading note:** cost is calculated from usage and the model price; a zero or outdated price makes the cost report wrong. "Closed" in a provider's status means the breaker is **closed** and normal, not disabled.

![Overview with KPIs, chart and top consumers](screenshots/overview.png)

## Providers — `/providers`

Writing is available to OWNER and ADMIN.

1. **Add a provider:** select a preset. For Azure or OpenAI-compatible providers, complete the Base URL. Enter a name and a credential; in the network settings, change the proxy, the four timeouts and the max concurrency only if needed.
2. **Test:** the provider card's test uses the default credential, and the row's test uses that same credential. The result shows latency, status and sometimes the number of models. Do not confuse 401/403 with network health.
3. **Discover models:** compares the upstream models with the organization's catalog. A known model is added with its catalog price; for an unknown model, enter the input/output price yourself.
4. **Credentials:** give each one a recognizable name and a weight. A custom header in the form `name: value` on each line, and an optional dedicated proxy, are allowed. After saving, only the masked secret and the header names are visible.
5. **Rotation / disabling:** to replace a secret, click **Rotate** and enter the new value; then test it. Disable is an immediate way to remove a credential from service. Deleting a provider is soft and disables it; deleting a model may be refused while it is in use.

**Check after a change:** the provider and the credential are active, the test passes, the model/alias exists, and a test request in the log reaches the intended provider. Seeing the breaker as closed alone does not prove the credential is correct.

![Provider and credential management with mock data](screenshots/providers.png)

## Virtual keys — `/keys`

The list can be filtered by name/prefix, project and status. The cost, count and tokens of each key in the current range are visible.

### Create

Choose a project and a name. An empty `allowedModels` means all models of the organization; to reduce access, enter model/alias/combo names separated by commas or new lines. RPM, TPM and max concurrency are optional. Set the expiry, the IP/CIDR allowlist and the daily/monthly budget according to the consumer.

### Safe rotation

1. Click **Rotate** and set the grace period for the old key (default 24 hours).
2. Put the new key, which is shown only once, in your secret manager, and move the clients to it.
3. The old key works until the grace period ends. After the migration, confirm with the logs/last-used time that it is no longer in use. If there is an active leak, do not wait for the grace period; **revoke** it immediately.

A `rotating` status means a replacement has been issued; `expired` and `revoked` keys cannot be used. MEMBER can also create keys; VIEWER can only view them.

![Virtual key list and limits](screenshots/keys.png)

## Models and Combos — `/models`

This page has three sections: model, alias and combo.

- **Model:** choose from the catalog to fill in the price, context and capabilities, or create a custom one. The `slug` is the name used in the API; `upstreamModel` is the provider's real name. Input and output prices are entered per million tokens, in USD. Editing a price manually detaches the model from the catalog sync; the catalog sync updates dependent models to the new version.
- **Combo:** add at least one and at most 20 unique models. Change the order by dragging or with the arrows. Retry means re-attempting a candidate, and fallback means moving to the next candidate; keep both limited. Before saving, the preview shows the priority/round-robin order or the weighted distribution.
- **Alias:** connect a stable name to a model or combo. The model/alias/combo namespace is shared, and a duplicate name is rejected.

`bad_request` and `content_filter` have no fallback. If part of a stream has already reached the client, no fallback is performed. The provider's final timeout takes priority over the combo's timeout setting.

![Model, alias and Combo management](screenshots/models.png)

## Request logs — `/logs`

The time, requested model, HTTP status/error code, total tokens, cost and latency are shown. Filters created from Overview appear as chips and as URL query parameters, so the link can be shared. Removing a chip clears that filter. The table loads the next page on scroll, and a "More" button also appears when a cursor exists.

- For troubleshooting, narrow the range and limit the model/key/project/status.
- This page shows metadata; it does not show the full prompt and response. Match the `X-Request-Id` of the gateway's response with the structured log of the gateway/worker.
- End-to-end latency is different from TTFT. Do not confuse a provider error with an admission error such as a rate limit or budget.
- If a new request does not appear, first wait a little and check the filters; then check the queue backlog and the worker according to the [Runbook](../runbook.md#8-usage-and-request-log-delay-or-loss).

![Request logs with filters and cost](screenshots/logs.png)

## Health — `/health`

- **Nodes:** the replica ID, config version, ready state and last seen time. Very different versions, or a stale last-seen time, indicate a sync or heartbeat problem.
- **Providers:** the breaker, error count / total, and the next half-open time. Credentials show their cooldown, temporary disable or model lockout separately.
- **Models:** only models whose breaker is not closed are listed; the message "all closed" means the breaker state is normal.

OWNER and ADMIN can click reset. A reset **does not fix the cause**, and it does not restore a wrong credential or an exhausted quota. First fix the connection and the error, then reset if needed and send a test request. Resets are recorded in the audit log and announced to the reachable replicas.

![Health of nodes, providers and credentials](screenshots/health.png)

## Organization — `/organization`

- OWNER/ADMIN can change the organization name. If you have several memberships, the organization selection is on this page.
- Members are invited with the OWNER, ADMIN, MEMBER or VIEWER role. A pending invitation can be revoked. If SMTP is not configured, deliver the invitation link to the person securely; do not post it in a public channel.
- A team groups projects, and a project owns virtual keys and is the boundary for reports and limits. Do not delete a team or project before reviewing its dependencies.
- Removing a member or demoting an OWNER must be done with a replacement owner and an access review. Give regular users the minimum role they need.

| role   | main access                                                        |
| ------ | ------------------------------------------------------------------ |
| OWNER  | full management of the organization and roles                      |
| ADMIN  | management of providers/config and permitted members, health reset |
| MEMBER | create projects and keys, view, and permitted operational work     |
| VIEWER | view only; no write or reset buttons                               |

![Members, invitations, teams and projects](screenshots/organization.png)

## Connection guides — `/guides`

Claude Code, Codex, Cursor, Cline, Roo Code, Continue, Aider, the OpenAI Python/Node SDKs, the Anthropic SDK and curl are supported.

1. Choose the tool and the model/alias name.
2. Create a new key, or temporarily enter the full value of an existing key. Selecting a key name from the list does **not** recover its secret value.
3. Copy the snippet. After copying, the entered value is cleared from the page. The copied snippet contains the secret, so do not paste it into a public issue or chat.
4. The OpenAI endpoint is usually `<gateway>/v1`, and the Anthropic one is the gateway root. Change the model to your organization's real name; `gpt-4.1` is only a default/example.

![Tool connection guides](screenshots/guides.png)

## Account — `/account`

Enter your current password and a new password of at least 10 characters. After the change, all sessions are revoked and you are sent to the login page. Keep the password in a password manager; do not enter it into a screenshot or any other form.

![Account password change](screenshots/account.png)

## Common scenarios

### A) Subscription first, then cheap API

1. Create two separate providers, each with a healthy credential, for a subscription model and a cheap API; the test of both must succeed.
2. Register the matching model of each provider with the correct upstream name, context and price.
3. Create a combo: `priority`, with the subscription model at order 0 and the cheap API at order 1.
4. Set `fallbackOn` only for the errors where switching makes sense, usually `rate_limit`, `overloaded`, `server`, `timeout` and `connection`. For 401/403, first fix the credential, and do not rely on blind fallback.
5. Point a stable alias to the combo; the virtual key should allow only this alias.
6. Get a 200 from the healthy provider. Then, in a test environment, disable or break the primary and check that the response reaches the secondary, and that the header/attempt log proves it. Do not cause deliberate failures in production without authorization.

### B) Fallback between several credentials of one provider

1. Create two separate credentials with independent accounts/quotas and clear names; give them equal initial weights.
2. Register the model only once for the provider; the credentials become the candidates of the same model.
3. Create the virtual key and the combo/alias, and allow `rate_limit` in the fallback.
4. In testing, make the first credential return 429. Expect the other credential to be tried, and the first one to enter cooldown; a model-specific 429 may only be a lockout of that model.
5. Check Health and the logs. Several credentials on one shared account or quota do not create independent capacity.

### C) Migration without changing the model name in the client

Create a stable alias and restrict the key to it. First connect the alias to the current model; test the new model, and then change the alias target. Compare one test request, and the error rate and cost, before and after. From the client's point of view, a rollback is just reverting the alias target.

## Common errors

| observed                                       | meaning and first action                                                                                                               |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 401 `invalid_api_key` / `api_key_expired`      | the full key is correct, not revoked or expired, and it goes to the same organization/environment. If in doubt, rotate it.             |
| 403 `model_not_allowed`                        | the model/alias name is not in the key's `allowedModels`; fix the restriction or send an allowed model.                                |
| 404 `model_not_found`                          | the model/alias/combo does not exist in the organization or the name is wrong; get the exact name from the Models page.                |
| 429 `rate_limited`                             | the RPM/TPM/concurrency of one of the scopes is full; respect `Retry-After` and fix the burst pattern.                                 |
| 429 `budget_exceeded`                          | the period cap has been reached; review the usage and, if needed, deliberately adjust the budget. Period counting is UTC.              |
| 503 `no_available_provider`                    | the provider/model/credential is disabled, the breaker is open, or there is a cooldown. Check Health, and test after fixing the cause. |
| 401/403 from upstream                          | check the upstream secret, access or quota. A closed breaker alone does not prove the secret is healthy.                               |
| Provider response with tool format not working | match the Base URL and the tool's wire protocol with the guide; check the alias name and the model's tools/streaming capability.       |

For infrastructure outages and secret leaks, use the [operational Runbook](../runbook.md).

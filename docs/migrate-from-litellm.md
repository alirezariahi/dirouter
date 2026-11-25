# Migrating from LiteLLM

LiteLLM Proxy and DiRouter solve the same problem: one OpenAI-compatible endpoint in front of many
providers, with virtual keys, budgets and fallback. The client side of a move is small (a base URL
and a key). The server side is different: DiRouter has no `config.yaml`; providers, models,
routing, keys and limits live in PostgreSQL, are edited in the dashboard or through the admin API
(`https://admin.<your-domain>/api/v1`), and reach every gateway replica as a versioned config
snapshot. This page maps each LiteLLM setting to its place in DiRouter and lists what has no
equivalent.

## 1. Clients

| LiteLLM                                                   | DiRouter                                                                                      |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `http://litellm:4000` or `…/v1`                           | `https://api.<your-domain>/v1` (dev: `http://api.localhost/v1`)                               |
| `sk-…` virtual key                                        | `dr-…` virtual key                                                                            |
| `Authorization: Bearer` / `x-api-key`                     | the same                                                                                      |
| `/anthropic/v1/messages` (pass-through)                   | `/v1/messages`, native: any model, any provider, translated when needed                       |
| `/v1/rerank`, `/v1/moderations`, batches, files, realtime | the same paths under `/v1`                                                                    |
| other pass-through routes                                 | `/passthrough/{provider}/…`, per provider allow-list ([pass-through](gateway/passthrough.md)) |

The official OpenAI, Anthropic and Cohere SDKs work unchanged; the sprint 5 endpoints are checked
with them in `scripts/e2e/sprint-5/34.1.mjs`.

## 2. `model_list`

A LiteLLM deployment is split into three objects in DiRouter:

```yaml
# LiteLLM
model_list:
  - model_name: gpt-4.1
    litellm_params:
      model: openai/gpt-4.1
      api_key: os.environ/OPENAI_API_KEY
      rpm: 600
  - model_name: gpt-4.1
    litellm_params:
      model: azure/gpt-4.1-eu
      api_base: https://my-eu.openai.azure.com
      api_key: os.environ/AZURE_KEY
```

| LiteLLM                                               | DiRouter                                                                                                                                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| provider prefix (`openai/`, `azure/`, …) + `api_base` | a **provider**: type (`openai`, `azure-openai`, `anthropic`, `gemini`, `bedrock`, `vertex`, `openai-compatible`, …) or a preset, and its base URL ([providers](providers/README.md)) |
| `api_key`                                             | the provider's **credentials**, stored encrypted; several per provider, each with a `weight`                                                                                         |
| `litellm_params.model`                                | a **model** on that provider (`upstreamModel`), with its own slug                                                                                                                    |
| `model_info`, `input_cost_per_token`, …               | the model's `pricing` in USD **per million tokens** (multiply LiteLLM's per-token price by 1,000,000), or a `catalogKey` that fills price and context from the catalog               |
| several deployments with one `model_name`             | a **combo** whose targets are those models, or one model with several credentials                                                                                                    |
| `model_name` / `model_group_alias`                    | the combo slug, or an **alias** pointing at a model or combo                                                                                                                         |

DiRouter's price catalog is synced from LiteLLM's own `model_prices_and_context_window.json`
([catalog sync](catalog-sync.md)), so models created with a `catalogKey` carry the same prices you
had, including OpenAI's flex and priority tiers.

The per-deployment `rpm` / `tpm` of LiteLLM has no direct equivalent: limits are set on keys,
projects and teams, and an upstream 429 puts the credential (or only that model on it) into a
cooldown while the other credentials keep serving ([routing](concepts/routing.md)).

## 3. `router_settings`

| LiteLLM                            | DiRouter                                                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `routing_strategy: simple-shuffle` | combo strategy `weighted` (or `round-robin`)                                                                                                                                    |
| `least-busy`                       | `least-used` (fewest recent and in-flight requests)                                                                                                                             |
| `latency-based-routing`            | `latency` (PeakEWMA with power-of-two choices)                                                                                                                                  |
| `cost-based-routing`               | `cost` (cheapest estimate for this request)                                                                                                                                     |
| `usage-based-routing(-v2)`         | closest is `least-used`; there is no per-deployment TPM/RPM accounting                                                                                                          |
| order / priority of deployments    | `priority` with `order` per target                                                                                                                                              |
| `num_retries`, `retry_after`       | the combo's `retryMaxAttempts`; backoff with full jitter, `Retry-After` honored                                                                                                 |
| `fallbacks`                        | more targets in the combo and `fallbackOn` (the error classes that move on), or the client's `models` array                                                                     |
| `context_window_fallbacks`         | built in: a target too small for the request is skipped, and after a `context_length` error only larger windows are tried                                                       |
| `content_policy_fallbacks`         | not available: a `content_filter` error never falls back                                                                                                                        |
| `allowed_fails`, `cooldown_time`   | automatic circuit breakers per provider and per model, shared by all replicas, and credential cooldowns                                                                         |
| `timeout`, `stream_timeout`        | layered timeouts: `connectMs`, `firstByteMs`, `idleMs`, `totalMs`, per gateway, combo and provider                                                                              |
| tag-based routing                  | conditional routing rules on headers, `metadata`, key, project, team, budget spend and more; a rule can also `tag` a request ([routing policies](concepts/routing-policies.md)) |

DiRouter adds routing LiteLLM does not have in the same form: OpenRouter-style `provider`
preferences in the request, data-policy routing (ZDR, region), canary and percentage splits,
shadow traffic, request hedging and a routing simulator that runs the live planner
([request-level routing](concepts/request-routing.md)).

## 4. `litellm_settings` and `general_settings`

| LiteLLM                                              | DiRouter                                                                                                                                                                           |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `drop_params: true`                                  | the default. Turn it off per organization, per request (`drop_params` in the body) or with `x-dirouter-drop-params: false`                                                         |
| per-model `additional_drop_params`, defaults         | the model's or alias's `requestPolicy`: `defaults`, `overrides`, `drop`, `unsupported` ([parameter policy](gateway/translation.md))                                                |
| `cache: true` (Redis)                                | exact cache and semantic cache in the gateway settings, isolated per project ([caching](concepts/caching.md))                                                                      |
| `guardrails`                                         | guardrail policies: regex, keywords, PII, secrets, prompt injection, JSON Schema, moderation, with block, redact or flag ([guardrails](concepts/guardrails.md))                    |
| `success_callback` / `callbacks` (Langfuse, OTEL, …) | OpenTelemetry traces, metrics and logs with GenAI semantic conventions, Prometheus metrics, and the request log ([observability](observability.md)); there are no vendor callbacks |
| `master_key`                                         | no master key on the gateway. People sign in to the dashboard with roles (RBAC, SSO); automation uses service-account tokens on the admin API                                      |
| `database_url`                                       | DiRouter's own PostgreSQL; the gateway does not touch it on the request path                                                                                                       |
| `alerting` (Slack, …)                                | alert rules with Slack, Telegram, e-mail and webhook channels, including budget thresholds and low upstream balances ([alerts](alerts.md))                                         |

## 5. Virtual keys, teams and budgets

| LiteLLM `/key/generate`          | DiRouter `POST /orgs/:org/keys`                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `models`                         | `allowedModels` (empty means all)                                                                             |
| `max_budget` + `budget_duration` | `budgets: [{ period: "daily" \| "monthly", limitUsd, limitTokens?, alertThresholds? }]`, UTC calendar periods |
| `rpm_limit`, `tpm_limit`         | `rpm`, `tpm`                                                                                                  |
| `max_parallel_requests`          | `maxConcurrency`                                                                                              |
| `duration` / `expires`           | `expiresAt`                                                                                                   |
| `team_id`                        | `projectId`: every key belongs to a project, and a project can belong to a team                               |
| `/key/regenerate`                | `POST /orgs/:org/keys/:id/rotate` with a grace period in which both keys work                                 |
| `/key/delete`, block             | `POST /orgs/:org/keys/:id/revoke`                                                                             |
| —                                | `ipAllowlist`, pass-through grants, routing policy per key                                                    |

Team and project rate limits and budgets are set with `PUT /orgs/:org/limits/{team|project}/:id`
([limits](concepts/limits.md)). A spent budget answers **429 `budget_exceeded`** with `Retry-After`
until the next period. Keys cannot be imported: LiteLLM stores only hashes, so issue new keys and
hand them out.

`budget_duration` values other than a day or a calendar month (`7d`, `30d`) are not available;
use `monthly` or `daily`. A prepaid organization wallet exists for selling access.

## 6. Spend and logs

| LiteLLM                            | DiRouter                                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| `/spend/logs`, `LiteLLM_SpendLogs` | Log Explorer and `GET /orgs/:org/logs/:id`, ledger-backed usage API and the Cost page               |
| `user` field for end-user spend    | recorded with each request as the end user; there are no per-end-user budgets                       |
| request/response storage           | optional request bodies with payload view and replay ([request bodies](concepts/request-bodies.md)) |

## 7. Not available

- A `config.yaml` file. The admin API's `export.yaml` / `import.yaml` move DiRouter's own config
  image between installations with the same keyring; they do not read LiteLLM's format, and there
  is no automatic importer. Recreate providers, models and combos in the dashboard or with a short
  script against the admin API ([control-api](api/control-api.md)).
- LiteLLM's Python SDK mode (`litellm.completion(...)` in-process): DiRouter is a server only.
- Per-deployment `rpm` / `tpm` limits, `content_policy_fallbacks`, per-end-user budgets, budget
  periods other than daily and monthly.
- Vendor logging callbacks; use the OpenTelemetry export.

## Checklist

1. Create the providers and their credentials; register each `litellm_params.model` as a model,
   from the catalog where possible.
2. Turn each `model_name` with several deployments into a combo, and keep the old names as
   aliases.
3. Create teams, projects and keys with their limits and budgets; hand out the new keys.
4. Move caching, guardrails and alerts to their DiRouter settings.
5. Point clients at the new base URL; check the first requests in the routing simulator and the
   Log Explorer.

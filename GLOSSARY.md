# Glossary

Core DiRouter concepts. Use these names consistently in code, APIs, and the dashboard. Some options below describe the target product rather than completed functionality.

## Core concepts

### Provider

An LLM service to which gateway forwards requests, such as OpenAI, Anthropic, Gemini, Azure OpenAI, or an OpenAI-compatible server (vLLM, Ollama, and others). Each provider has a `type` (adapter), `baseUrl`, timeout/proxy settings, and one or more credentials.

### Credential

An API key or other credential for a provider. A provider can have multiple credentials to distribute traffic and continue when one enters cooldown. Credentials are encrypted with AES-256-GCM and `MASTER_KEY`; plaintext secrets must never be stored or logged.

### Model

A specific model on one provider, identified by a public DiRouter `slug` (for example, `openai/gpt-4.1`), an `upstreamModel`, prices, a context window, and capabilities such as tools, vision, and reasoning. The same underlying model on two providers, such as OpenAI and Azure, is represented by two Model records.

### Alias

An alternative name supplied in the client's `model` field that resolves to a Model or Combo. For example, `gpt-4.1` can resolve to `openai/gpt-4.1`, or `best` to a combo. Aliases allow the underlying model to change without client changes.

### Combo

An ordered group of models with a selection strategy, retry policy, and timeouts. MVP contracts define `priority`, `round-robin`, and `weighted`; other strategies belong to later work. When a target fails, gateway may fall back to the next target. Combos are central to DiRouter's resilience.

### Virtual Key

A DiRouter API key issued to a user or application, such as `dr-live-...`. Clients authenticate with it instead of a provider's real key. Each virtual key belongs to a Project and can restrict models, rate limits, budgets, expiration, and source IPs. Only its HMAC-SHA256 hash is stored; the raw key is shown once at creation.

### Budget

A cost or token ceiling for a virtual key, project, or team. The current database design supports daily and monthly budgets; broader periods such as weekly or total are future options. Monetary values are USD decimal strings at contract boundaries, stored as `Decimal(18,8)` and calculated with BigInt fixed-point arithmetic. Reaching a budget returns `budget_exceeded` with HTTP 429.

## Access hierarchy

| Concept          | Description                                                                 |
| ---------------- | --------------------------------------------------------------------------- |
| **Organization** | Top-level owner of providers, teams, and user memberships                   |
| **Team**         | A grouping of projects with shared budgets and limits                       |
| **Project**      | A unit of consumption to which virtual keys belong                          |
| **User**         | A dashboard user with an RBAC role; MVP memberships are organization-scoped |

## Architecture concepts

| Concept             | Description                                                                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Data plane**      | Gateway: the hot path of every LLM request                                                                                                                                       |
| **Control plane**   | control-api, worker, and dashboard: management and reporting                                                                                                                     |
| **ConfigSnapshot**  | A complete, versioned configuration containing providers, models, combos, aliases, virtual keys, and limits; published by control-api and retained in gateway memory and on disk |
| **UsageEvent**      | A request's consumption event (tokens, cost, attempt chain), delivered asynchronously to worker                                                                                  |
| **Canonical model** | The internal request/response format to which inbound and outbound APIs are translated                                                                                           |
| **Inbound API**     | The API used by the client (`openai.chat` or `anthropic.messages`); responses and errors use the same format                                                                     |
| **Ledger**          | The financial usage record in PostgreSQL; the accounting source of truth                                                                                                         |
| **Attempt**         | One attempt to send a request to a Model using a Credential; a request can have multiple attempts                                                                                |

## Resilience concepts

| Concept             | Description                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Fallback**        | Move to the next combo target after the current target fails                                                  |
| **Retry**           | Retry the same target with backoff and jitter, for transient errors only                                      |
| **Circuit Breaker** | Temporarily stop sending to a repeatedly failing provider/model; states are `closed`, `open`, and `half-open` |
| **Cooldown**        | Temporarily exclude a rate-limited credential, using `Retry-After` where available                            |
| **Lockout**         | Temporarily exclude a model on one provider, for example when it becomes unavailable                          |
| **Bulkhead**        | A concurrency ceiling per provider or tenant so a slow component cannot exhaust the whole system              |
| **TTFT**            | Time to first token; the first meaningful response/token latency measurement                                  |
| **Fail mode**       | Limiter/budget behavior when Valkey is unavailable: `open` permits requests and `closed` rejects them         |
| **Outbox**          | Gateway's local file holding UsageEvents while the queue is unavailable                                       |
| **Idempotency key** | An event's unique key used to prevent duplicate charges                                                       |

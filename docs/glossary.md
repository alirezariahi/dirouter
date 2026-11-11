[English](glossary.md) · [فارسی](glossary.fa.md)

# Glossary

> Every document is bilingual: an English `.md` file and a Persian `.fa.md` file sit side by side, and detailed guides live in `code/docs/`. See [CONTRIBUTING.md](../CONTRIBUTING.md) for the [documentation policy](../CONTRIBUTING.md#documentation-policy).

Core concepts of DiRouter. The names in code, API, and dashboard are exactly these.

## Core concepts

### Provider

An LLM service to which the gateway sends requests, such as OpenAI, Anthropic, Gemini, Azure OpenAI, or any OpenAI-compatible server (vLLM, Ollama, …). Each provider has a `type` (adapter type), a `baseUrl`, timeout and proxy settings, and one or more Credentials.

### Credential

A key or credential for accessing a Provider. A Provider can have several Credentials so that load is shared among them, and if one reaches its limit (cooldown), the others are used. Credentials are encrypted with AES-256-GCM and MASTER_KEY, and are never stored or logged in plain text.

### Model

A specific model on a Provider, with its DiRouter public name (`slug`, e.g. `openai/gpt-4.1`), its model name at the provider (`upstreamModel`), price, context length, and capabilities (tools, vision, reasoning). The same model on two providers (for example GPT-4.1 on OpenAI and on Azure) is two separate Models.

### Alias

An alternative name that the client sends in the `model` field, pointing to a Model or a Combo; for example `gpt-4.1` pointing to `openai/gpt-4.1`, or `best` pointing to a Combo. With an Alias you can change the model behind a name without changing clients.

### Combo

An ordered group of Models with a selection strategy (`priority`, `round-robin`, `weighted`, `random`), a retry policy, and a timeout. If the first target fails, the gateway falls back to the next target. Combo is the core of DiRouter's resilience.

### Virtual Key

An API key that DiRouter gives to a user or application (for example `dr-live-…`). The client authenticates with it instead of the real provider key. Each Virtual Key belongs to a Project and can have allowed models, a rate limit, a Budget, an expiry date, and an IP restriction. Only the HMAC-SHA256 of the key is stored, and the key itself is shown only once, when it is created.

### Budget

A cost cap over a time period (`daily`, `weekly`, `monthly`, `total`) at the level of a Virtual Key, Project, or Team. In the API, amounts are dollar decimal strings with at most 8 decimal places; in the database they are `Decimal(18,8)`; and in calculations they use BigInt fixed-point. The current database periods are daily and monthly; weekly and total are future options. When the cap is reached, the request is rejected with the `budget_exceeded` error (HTTP 429).

## Access hierarchy

| Concept          | Description                                                    |
| ---------------- | -------------------------------------------------------------- |
| **Organization** | Top level; owns all Providers, Teams, and users                |
| **Team**         | A group of users and projects with a shared budget and limits  |
| **Project**      | Unit of usage; Virtual Keys belong to a Project                |
| **User**         | Dashboard user with a role (RBAC) in an Organization or a Team |

## Architecture concepts

| Concept             | Description                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Data plane**      | The gateway; the hot path of every LLM request                                                                                                                                       |
| **Control plane**   | control-api, worker, and dashboard; management and reporting                                                                                                                         |
| **ConfigSnapshot**  | A complete, versioned picture of the configuration (Providers, Models, Combos, Aliases, Virtual Keys, limits) that control-api publishes and the gateway keeps in memory and on disk |
| **UsageEvent**      | The usage event of each request (tokens, cost, attempt chain) that reaches the worker asynchronously                                                                                 |
| **Canonical model** | The internal request and response format into which all input and output APIs are translated                                                                                         |
| **Inbound API**     | The API the client used to send the request (`openai.chat` or `anthropic.messages`); responses and errors are returned in the same format                                            |
| **Attempt**         | One attempt to send a request to a Model and Credential; one request can have several Attempts                                                                                       |

## Resilience concepts

| Concept             | Description                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Fallback**        | Moving to the next Combo target after the current target fails                                                    |
| **Retry**           | Trying the same target again with backoff and jitter, only for transient errors                                   |
| **Circuit Breaker** | Temporarily stopping sends to a Provider or Model that fails repeatedly; states `closed`, `open`, and `half-open` |
| **Cooldown**        | Temporarily setting aside a Credential that hit a rate limit, until the `Retry-After` time                        |
| **Lockout**         | Temporarily locking a Model on a Provider (for example when the model is unavailable)                             |
| **Bulkhead**        | A cap on concurrent requests per Provider or tenant so that one slow part does not bring down the whole system    |
| **TTFT**            | Time To First Token; the time until the first byte of the response                                                |
| **Fail mode**       | The behavior of the limiter and budget when Valkey is unavailable: `open` (allow) or `closed` (reject)            |
| **Outbox**          | A local gateway file that holds UsageEvents when the queue is unavailable                                         |
| **Idempotency key** | A unique key for each event that prevents a cost from being recorded twice                                        |

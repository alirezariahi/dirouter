# Migrating from OpenRouter

DiRouter speaks the request format OpenRouter clients send: the OpenAI API, the `provider`
preferences object, the `models` fallback array, model suffixes such as `:floor` and `:online`, and
the `web` plugin. In most applications the move is a base URL, a key and the model names. This page
lists what maps one to one, what maps with a difference, and what does not exist in DiRouter.

The official OpenAI and Anthropic SDKs are checked against these features on every sprint
(`scripts/e2e/sprint-5/34.1.mjs`).

## 1. Base URL and key

| OpenRouter                               | DiRouter                                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| `https://openrouter.ai/api/v1`           | `https://api.<your-domain>/v1` (dev: `http://api.localhost/v1`)                          |
| `sk-or-…` key                            | a virtual key `dr-…`, created per project on the **Keys** page or `POST /orgs/:org/keys` |
| `Authorization: Bearer`                  | the same; `x-api-key` works too (the Anthropic SDK sends it)                             |
| Anthropic clients (Claude Code and SDKs) | `ANTHROPIC_BASE_URL=https://api.<your-domain>` (the SDK adds `/v1/messages`)             |

```ts
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'https://api.example.com/v1', // was https://openrouter.ai/api/v1
  apiKey: process.env.DIROUTER_KEY, // was the OpenRouter key
});
```

`HTTP-Referer` and `X-Title` are not needed and are ignored. The key's limits (allowed models,
RPM/TPM, concurrency, IP allow-list, expiry, daily and monthly budgets) are set on the key, its
project and its team, not in the request ([virtual keys](control-api/keys.md),
[limits and budgets](concepts/limits.md)).

## 2. Model names

OpenRouter has one global list of names (`openai/gpt-4.1`, `anthropic/claude-sonnet-4.5`). In
DiRouter every organization has its own namespace: an operator connects providers with their own
credentials, registers models (price and context come from the catalog), and gives clients names
([routing](concepts/routing.md)):

- a **model** slug, which may contain `/`, so you can keep the OpenRouter names (`openai/gpt-4.1`);
- an **alias**, a stable name that points at a model or a combo; rename targets without touching
  clients;
- a **combo**, one name for several targets with a strategy (`priority`, `weighted`,
  `round-robin`, `latency`, `cost`, `least-used`, `headroom`), retries and the error classes that
  fall back.

To keep client code unchanged, create aliases or model slugs with exactly the names the
application sends today. `GET /v1/models` lists what the key may use.

A gradual move is possible too: the `openrouter` provider preset uses OpenRouter itself as an
upstream ([OpenRouter provider](providers/openrouter.md)), so some models can stay on OpenRouter
while others move to direct providers. Its credit balance is read like the other balance APIs
([upstream balances](upstream-balances.md)).

## 3. Provider preferences and fallback models

The `provider` object is read in OpenRouter's own format; `provider`, `models` and `route` are
never sent to a provider ([request-level routing](concepts/request-routing.md)).

| OpenRouter field                              | In DiRouter                                                                                                    |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `order`, `only`, `ignore`                     | same; a provider is named by its slug, type or display name (your DiRouter providers, not OpenRouter's list)   |
| `allow_fallbacks`                             | same                                                                                                           |
| `sort` (`price`, `throughput`, `latency`)     | same; `{"by": …}` is accepted. Throughput and latency are measured live by the gateway                         |
| `max_price`                                   | `prompt`, `completion` (USD per million tokens), `request`, `image`; compared with the price the customer pays |
| `zdr: true`                                   | zero-data-retention providers only, from the provider's `dataPolicy`                                           |
| `data_collection: "deny"`                     | only providers marked as not training on data                                                                  |
| `models: [...]`                               | up to 8 fallback models after `model`                                                                          |
| `route: "fallback"`                           | accepted; fallback is the behavior anyway                                                                      |
| `require_parameters`, `quantizations`, others | accepted and ignored                                                                                           |
| —                                             | DiRouter extensions: `regions`, `countries`                                                                    |

Differences that matter:

- An administrator can set the same preferences per organization, project or key, and **lock**
  them (`lockProvider`): the client's `provider`, `models` and sorting suffixes are then ignored and
  the answer carries `x-dirouter-preferences: locked`. Data policy (ZDR, training, region) can only
  be made stricter by a request, never weaker.
- Preferences that leave no candidate fail with **400 `no_provider_matches_preferences`** and the
  reasons, instead of being relaxed.
- A provider without a `dataPolicy` fails `zdr` and `data_collection: "deny"`; describe your
  providers before relying on these fields.

## 4. Model suffixes

| Suffix                                              | DiRouter                                                                         |
| --------------------------------------------------- | -------------------------------------------------------------------------------- |
| `:nitro`                                            | `sort: "throughput"`                                                             |
| `:floor`                                            | `sort: "price"`                                                                  |
| `:free`                                             | only targets whose configured price is zero                                      |
| `:online`                                           | the gateway's own web search before the model answers (needs web search enabled) |
| `:thinking`, `:minimal`, `:low`, `:medium`, `:high` | reasoning effort (`:thinking` is `medium`)                                       |

Suffixes chain (`openai/gpt-4.1:floor:online`) and a name that exists as written is never split.
They work on `/v1/chat/completions`, `/v1/responses` and `/v1/messages`.

`:online` searches the last user message, puts the results in front of the system prompt and bills
the search as its own `web.search` usage row. On `/v1/chat/completions` the answer carries the
sources as `url_citation` annotations, and on `/v1/messages` as `web_search_tool_result` blocks, as
with `plugins: [{ "id": "web" }]` ([web search](gateway/web-search.md)). On `/v1/responses` the
results reach the model but the sources are not returned; use chat completions when you read them.
Without a web search backend, `:online` fails with 400 `web_search_unavailable`, while the plugin
form answers without results and says so in `x-dirouter-web-search: unavailable`.

## 5. Other request fields

- **Reasoning:** send `reasoning_effort` (or a suffix). OpenRouter's `reasoning` object is not
  read on Chat Completions.
- **Service tier:** `service_tier` (`flex`, `priority`, …) is passed to OpenAI-style providers and
  priced from the model's tier prices.
- **Usage:** non-streamed answers always carry `usage`; for streams send
  `stream_options: { include_usage: true }`. `usage: { include: true }` is not needed.
- **Unsupported parameters** are dropped by default; with `drop_params: false` (body, the
  `x-dirouter-drop-params` header or the organization setting) the request fails with a 400 that
  names them ([parameter policy](gateway/translation.md)).
- **Response headers:** `x-dirouter-provider`, `x-dirouter-model`, `x-dirouter-attempts` and
  `x-request-id` tell you who answered. With the key's `explain` permission, `x-dirouter-explain: 1`
  returns the whole routing decision in `x-dirouter-routing`.

## 6. Endpoints

Everything under `/v1` that OpenAI SDKs call is served: chat, Responses, legacy completions,
embeddings, images (generations, edits, variations), audio (speech, transcriptions,
translations), moderations, Files and Batch, videos, the Realtime WebSocket and client secrets,
plus `/v1/messages` for Anthropic clients and `/v1/rerank` for Cohere and Jina clients. A
provider's own API that DiRouter does not translate can be reached through
`/passthrough/{provider}/…` with the same key, when the key and the provider allow it
([pass-through](gateway/passthrough.md)).

## 7. Not available

- OpenRouter's account endpoints: `/api/v1/generation`, `/api/v1/credits`, `/api/v1/keys`
  (provisioning keys) and `/api/v1/models` with OpenRouter's catalog fields. In DiRouter request
  details are in the Log Explorer and `GET /orgs/:org/logs/:id`, spend in the usage API and the
  Cost page, prepaid balance in the wallet, and keys are created through the admin API or a service
  account.
- The OpenRouter model catalog itself: only models your organization registered exist.
- `transforms` (middle-out) is not interpreted.
- BYOK in the OpenRouter sense does not apply: every upstream credential is yours and is stored
  encrypted in DiRouter.

## Checklist

1. Connect providers and register models; create aliases with the names your application uses.
2. Create a project key with its limits and budget.
3. Change the base URL and the key; leave `provider`, `models` and suffixes as they are.
4. Replace the `reasoning` object with `reasoning_effort`.
5. Compare a few requests in the routing simulator and the Log Explorer before switching traffic.

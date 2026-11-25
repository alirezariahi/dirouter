[English](request-routing.md) · [فارسی](request-routing.fa.md)

# Request-level routing

> Code: `packages/routing/src/plan.ts`, `preferences.ts`, `policy.ts` and `apps/gateway/src/route-request.ts` (sprint 5).

A request can steer routing itself, in the same format OpenRouter uses, and an administrator can set or lock the same choices per organization, project or key. Live traffic and the routing simulator run the same planner (`planRoute`), so the simulator always shows what a request would do.

Planning stages, in order:

1. Resolve the requested model, then each model of the `models` fallback array (the [resolver](routing.md#1-model-name-resolution) is unchanged).
2. Data policy: region, country, zero data retention and training use (card 32.5).
3. The `:free` suffix: free targets only (card 31.5).
4. Provider preferences (`provider` object): `only` and `ignore`, `max_price`, `sort`, then `order` and `allow_fallbacks`.

Every candidate removed on the way is listed in `skipped` with its reason.

## Provider preferences (card 32.1)

```json
{
  "model": "chat",
  "models": ["openai/gpt-4.1-mini", "anthropic/claude-haiku-4-5"],
  "provider": {
    "order": ["openai", "azure-eu"],
    "only": ["openai", "azure-eu", "anthropic"],
    "ignore": ["deepinfra"],
    "allow_fallbacks": true,
    "sort": "price",
    "max_price": { "prompt": 1, "completion": 4 }
  },
  "messages": [{ "role": "user", "content": "Hi" }]
}
```

| Field             | Effect                                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `order`           | These providers first, in this order; the rest follow. Wins over `sort`.                                                                                                                           |
| `only`            | Only these providers.                                                                                                                                                                              |
| `ignore`          | Never these providers.                                                                                                                                                                             |
| `allow_fallbacks` | `false`: nothing outside `order` (without `order`: only the first provider). Default `true`.                                                                                                       |
| `sort`            | `price` (estimated price of this request), `throughput` (output tokens per second, live) or `latency` (recent latency, live). `{"by": "price"}` is accepted too.                                   |
| `max_price`       | Highest price in USD per million tokens (`prompt`, `completion`), per request (`request`) or per image (`image`). Compared with what the customer pays (sale price and customer group multiplier). |
| `models`          | Up to 8 fallback models tried, in order, after `model`. A fallback the key may not use, or that does not exist, is skipped and reported.                                                           |

A provider is named by its slug, its type (`openai`, `anthropic`, …) or its display name, case-insensitively. Fields DiRouter does not use (`require_parameters`, `quantizations`, `data_collection`, …) are accepted and ignored, and `provider`, `models` and `route` are never sent to a provider, so a client written for OpenRouter works unchanged.

When the preferences leave no candidate, the request fails with **400 `no_provider_matches_preferences`** and the message counts the reasons, e.g. `above_max_price_prompt ×3`. A malformed `provider` object or `models` array is a 400 `invalid_request`.

Skip reasons added by this stage: `provider_not_in_only`, `provider_ignored`, `above_max_price_prompt` / `_completion` / `_request` / `_image`, `fallbacks_not_allowed`, and for fallback models `fallback_model_not_found`, `fallback_model_not_allowed`, `fallback_no_available_provider`, `fallback_context_length_exceeded`.

### Live throughput

Each replica measures every model's generation speed after each successful request (output tokens over the generation time, after the first token for a stream) as an EWMA. A model belongs to one provider, so this is the speed of that model on that provider. The simulator shows it per candidate as `signals.throughputTps`; `sort: "throughput"` orders by it, models without a measurement last.

### Routing policies and the admin lock

`PUT /orgs/:orgId/routing-policies` (permission `config:write`, so owners and admins only) sets the policy of one scope; `GET` lists them (`config:read`). `policy: null` removes it.

```bash
curl -X PUT "$ADMIN/orgs/$ORG/routing-policies" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"scope":"key","scopeId":"key_…","policy":{"provider":{"order":["azure-eu"],"max_price":{"prompt":2}},"lockProvider":true}}'
```

- `provider`: default preferences (camelCase: `order`, `only`, `ignore`, `allowFallbacks`, `sort`, `maxPrice`). Organization, project and key are combined; a more specific scope overrides a field of a broader one.
- `lockProvider: true` on any of the three scopes: the client's `provider` object and `models` array are ignored, and the response carries `x-dirouter-preferences: locked`. Without the lock, the client's fields override the administrator's field by field.

The policies reach the gateway in the config snapshot (`routingPolicies`) and every change is audited (`routing_policy.updated`).

### Simulator

`POST /orgs/:orgId/routes/simulate` accepts `provider` (the request form) and `models`. The response adds `models` (the model names the candidates came from), `preferences` (what was applied), `policy` (`lockProvider` and the scopes that applied) and `clientPreferencesIgnored`. The dashboard simulator has fields for both.

## Data policy and region (card 32.5)

Each provider can describe where it runs and what it does with request data (`dataPolicy` on `POST`/`PATCH /orgs/:orgId/providers/:id`; `null` clears it):

```json
{ "dataPolicy": { "region": "eu", "country": "DE", "zdr": true, "trainsOnData": false } }
```

`region` is a lowercase code of your choice (`eu`, `us`, …), `country` an ISO 3166-1 alpha-2 code, `zdr` means zero data retention, `trainsOnData` whether the provider may train on request data. A provider without metadata fails every requirement it does not prove: it is not ZDR, it may train, and it is in no region.

The requirements live in the routing policy of the organization, a project or a key (`PUT /orgs/:orgId/routing-policies`, see above):

```json
{
  "scope": "organization",
  "scopeId": "org_…",
  "policy": {
    "dataPolicy": {
      "requireZdr": true,
      "denyTraining": true,
      "allowedRegions": ["eu"],
      "allowedCountries": ["DE", "FR"]
    }
  }
}
```

The three scopes and the request are combined to the **strictest** policy: region and country lists intersect, `requireZdr` and `denyTraining` add up. A request can add restrictions in its `provider` object, never remove one, and this holds even when the preferences are not locked:

| Request field             | Requirement                                |
| ------------------------- | ------------------------------------------ |
| `zdr: true`               | `requireZdr` (`false` changes nothing)     |
| `data_collection: "deny"` | `denyTraining` (`"allow"` changes nothing) |
| `regions: ["eu"]`         | `allowedRegions` (DiRouter extension)      |
| `countries: ["DE"]`       | `allowedCountries` (DiRouter extension)    |

The data policy is applied right after resolution, before preferences, fallback and hedging: a removed provider is not a candidate at all, so no retry, fallback model or hedged attempt can reach it. It applies to every call that carries the caller's data: chat, `/v1/messages`, `/v1/responses`, Gemini, embeddings, images, audio, and the moderation and classifier calls of guardrails.

Removed candidates carry the reason `not_zdr`, `may_train_on_data`, `region_not_allowed` or `country_not_allowed`. When none is left the request fails with **400 `no_provider_matches_data_policy`** and the gateway logs the policy and the removed targets at `info`.

The simulator response has the effective `dataPolicy`, and every request log entry keeps a `routeDecision` with the data policy and the removed targets (column `request_log.route_decision`), shown in the request details of the Log Explorer.

## Model suffixes and service tier (card 31.5)

A model name can end in suffixes, as on OpenRouter. They can be chained (`gpt-4.1:floor:online`), and a name that exists as written is never split (an organization may call a model `x:free` itself).

| Suffix                                 | Effect                                                                                                       | Status                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| `:nitro`                               | `sort: "throughput"`: fastest measured target first                                                          | live                                       |
| `:floor`                               | `sort: "price"`: cheapest target first                                                                       | live                                       |
| `:free`                                | only targets whose price is zero; skip reason `not_free`, none left is 400 `no_provider_matches_preferences` | live                                       |
| `:thinking`                            | reasoning on, effort `medium`                                                                                | live                                       |
| `:minimal`, `:low`, `:medium`, `:high` | reasoning effort                                                                                             | live                                       |
| `:online`                              | web search before the model answers                                                                          | needs the web search extension (card 30.8) |

- An explicit `provider.sort` wins over `:nitro`/`:floor`, and so does an effort the request sets itself (`reasoning_effort`) over a reasoning suffix.
- On a key whose preferences are locked, `:nitro` and `:floor` are ignored like any client preference (`x-dirouter-preferences: locked`); `:free` only narrows and still applies.
- The model name in the answer and in the usage record is the name without suffixes; the suffixes are kept in the request log's routing decision.
- `:online` calls the gateway's web search extension (`webSearch` in `buildGateway`, interface `WebSearchExtension` in `apps/gateway/src/web-search.ts`), which adds the results to the request once the route is known. Without one, the request fails with **400 `web_search_unavailable`** and nothing is sent upstream. The simulator reports `webSearch: "available"` or `"unavailable"`.

The simulator accepts suffixed names and answers with `suffixes`, `reasoningEffort` and `webSearch`.

### Service tier

`service_tier` (`flex`, `priority`, `auto`, `default`, `scale`) in a Chat Completions or Responses request is passed to OpenAI-style providers (OpenAI, Azure OpenAI, OpenAI-compatible) and dropped for the others. A model's pricing can carry tier prices:

```json
{
  "pricing": {
    "inputPerMTok": "2",
    "outputPerMTok": "8",
    "serviceTiers": {
      "flex": { "inputPerMTok": "1", "outputPerMTok": "4" },
      "priority": { "inputPerMTok": "3.5", "outputPerMTok": "14", "cacheReadPerMTok": "0.875" }
    }
  }
}
```

The bundled catalog has them for OpenAI's `gpt-4.1` family, `gpt-4o`, `gpt-4o-mini`, `o3` and `o4-mini`, and catalog sync reads LiteLLM's `*_flex` and `*_priority` prices. Models that follow the catalog get them automatically; on `POST`/`PATCH /orgs/:orgId/models` they can be set under `pricing.serviceTiers`.

A `flex` or `priority` request is priced at the tier's rates: the cost, the sale price, the wallet reservation, the usage event (`serviceTier`) and so the ledger. The tier comes from the provider's answer when it reports one (OpenAI does, and may serve `priority` as `default`), else from the request (streams). A model without tier prices is priced at its standard rate. The request log shows the tier in the details.

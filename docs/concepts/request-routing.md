[English](request-routing.md) · [فارسی](request-routing.fa.md)

# Request-level routing

> Code: `packages/routing/src/plan.ts`, `preferences.ts`, `policy.ts` and `apps/gateway/src/route-request.ts` (sprint 5).

A request can steer routing itself, in the same format OpenRouter uses, and an administrator can set or lock the same choices per organization, project or key. Live traffic and the routing simulator run the same planner (`planRoute`), so the simulator always shows what a request would do.

Planning stages, in order:

1. Resolve the requested model, then each model of the `models` fallback array (the [resolver](routing.md#1-model-name-resolution) is unchanged).
2. Provider preferences (`provider` object): `only` and `ignore`, `max_price`, `sort`, then `order` and `allow_fallbacks`.

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

[English](sprint-2.md) · [فارسی](sprint-2.fa.md)

# Sprint 2 feature guide (v1)

> Advanced resilience, more APIs and providers, caching, enterprise security, guardrails, alerts, analytics, versioned configuration and HA. Every feature below is **off by default** unless noted, so upgrading does not change the behaviour of an existing installation.

## Where each feature is documented

| Area                | Feature (card)                                                                                                                                                | Guide                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| APIs and providers  | Inbound Gemini API (11.1)                                                                                                                                     | [gateway/gemini-inbound.md](gateway/gemini-inbound.md)                                         |
|                     | OpenAI Responses API, `previous_response_id` (11.2)                                                                                                           | [gateway/responses.md](gateway/responses.md), [gateway/translation.md](gateway/translation.md) |
|                     | Bedrock, Vertex, Cohere, Mistral, Voyage, Jina (11.3)                                                                                                         | [providers/README.md](providers/README.md)                                                     |
|                     | `/v1/embeddings`, including the SDK's base64 transport (11.4)                                                                                                 | [gateway/embeddings.md](gateway/embeddings.md)                                                 |
| Routing             | `latency`, `cost`, `least-used`, `headroom`, PeakEWMA, P2C (12.1); hedging (12.2); health probes and uptime (12.3); session affinity (12.4); simulator (12.5) | [concepts/routing.md](concepts/routing.md#advanced-routing-sprint-2)                           |
| Caching and savings | Exact cache with stream replay (13.1); semantic cache per project (13.2); context compression (13.3)                                                          | [concepts/caching.md](concepts/caching.md)                                                     |
| Security            | MFA and mandatory MFA per role (14.1); custom roles (14.3); audit log (14.4); `MASTER_KEY` rotation (14.5)                                                    | [security.md](security.md)                                                                     |
|                     | SSO with OIDC and local Keycloak (14.2)                                                                                                                       | [sso.md](sso.md)                                                                               |
| Guardrails          | Engine, stream redaction, PII validators (15.1); policy page with live test (15.2)                                                                            | [concepts/guardrails.md](concepts/guardrails.md)                                               |
| Dashboard           | Cost and budgets (16.1), live view (16.3), analytics (16.4), playground (16.5), security, settings                                                            | [dashboard/sprint2-pages.md](dashboard/sprint2-pages.md)                                       |
| Alerts              | Rules, channels, test messages (16.2)                                                                                                                         | [alerts.md](alerts.md)                                                                         |
| Configuration       | Gateway-wide settings, versions, diff, rollback, export/import (17.1)                                                                                         | [control-api/config-sync.md](control-api/config-sync.md#versions-rollback-and-import-card-171) |
| Observability       | OpenTelemetry tracing with W3C propagation (17.2)                                                                                                             | [observability.md](observability.md#distributed-tracing-with-opentelemetry-card-172)           |
| Deployment          | Valkey Sentinel, PostgreSQL standby, replicas, backup and restore drill (17.3)                                                                                | [deploy-ha.md](deploy-ha.md)                                                                   |
| Testing             | Chaos test (18.1)                                                                                                                                             | [benchmarks/chaos.md](benchmarks/chaos.md)                                                     |

## Turning features on

Most runtime features are controlled by one JSON document, the gateway settings, edited on the **Settings and versions** page or with `PUT /orgs/:orgId/config/settings`. It is validated as a whole, stored in `gateway_settings`, and published to every gateway replica as a new config version.

```json
{
  "cache": {
    "exact": { "enabled": true, "ttlSeconds": 300 },
    "semantic": {
      "enabled": false,
      "projects": { "prj_support": { "enabled": true, "threshold": 0.92 } }
    }
  },
  "compression": { "enabled": true, "maxToolResultChars": 2000, "keepRecentMessages": 4 },
  "sessionAffinity": { "enabled": true },
  "healthProbe": { "enabled": true, "intervalSeconds": 60 },
  "tracing": {
    "enabled": true,
    "endpoint": "http://otel-collector:4318/v1/traces",
    "sampleRatio": 0.1
  }
}
```

Per-combo features (`strategy`, `hedging`, `sticky`) are set on the combo; guardrails, alerts, SSO, custom roles and MFA policy have their own pages.

The **semantic cache** needs more than the setting: a PostgreSQL image with the pgvector extension (build `deploy/docker/postgres.Dockerfile` and set `POSTGRES_IMAGE`; the default `postgres:17-alpine` does not have it) and `SEMANTIC_CACHE_EMBEDDING_URL`. The cache table is created automatically once the extension is available. Details in [concepts/caching.md](concepts/caching.md).

## Upgrading from Sprint 1

1. Apply the migrations (`make migrate`): `20261111000000_sprint2` and `20261120000000_gateway_settings` (gateway settings table, semantic-cache scope columns, pinned config versions). Both are additive.
2. Regenerate the Prisma client and the dashboard's generated API client, then rebuild the images.
3. New optional environment variables are listed in [env-reference.md](env-reference.md): `SEMANTIC_CACHE_EMBEDDING_*`, `POSTGRES_IMAGE`, `HEALTH_SAMPLE_RETENTION_DAYS`, `ALERT_EVALUATE_INTERVAL_MS`, and for the HA overlay `REPLICATION_PASSWORD`, `POSTGRES_HOST`, `HA_IP_PREFIX`, replica counts. `VALKEY_URL` now also accepts a Sentinel address.
4. Nothing needs to be enabled; existing keys, combos and providers keep working as before.

Behaviour changes worth knowing:

- `/v1/embeddings` now accepts `encoding_format: "base64"` (it used to answer 422), which is what the official OpenAI SDKs send by default.
- The exact cache key now includes the project id: entries written before the upgrade are not reused.
- Context compression never removes messages any more; it shortens and de-duplicates tool output instead.
- Semantic-cache entries are scoped to project and embedding model; entries from before the upgrade stop matching and expire.

## What has been verified, and what has not

State on 2026-11-20 (sprint 2 working tree, single Docker host: macOS Docker Desktop, 4 CPUs / 4 GB).

### Verified

- **Automated checks** pass locally: typecheck, ESLint, Prettier, the unit tests, and the integration suite on disposable PostgreSQL 17 and Valkey 8 containers.
- **End to end** on the development Compose stack through Traefik: `node scripts/e2e/sprint-2.mjs` runs 22 scenarios, one per feature:

  | Card | Scenario                                                                                           |
  | ---- | -------------------------------------------------------------------------------------------------- |
  | 11.1 | Gemini inbound, including streamed tool calls                                                      |
  | 11.2 | Responses API with a Codex-shaped request: typed stream events, tool calls, `previous_response_id` |
  | 11.4 | Embeddings, including metering                                                                     |
  | 12.4 | Session affinity                                                                                   |
  | 12.5 | Routing simulator                                                                                  |
  | 13.1 | Exact cache                                                                                        |
  | 13.2 | Semantic cache on pgvector                                                                         |
  | 13.3 | Compression                                                                                        |
  | 14.1 | MFA                                                                                                |
  | 14.2 | SSO with Keycloak (`compose.sso.yaml`)                                                             |
  | 14.3 | Custom roles                                                                                       |
  | 14.4 | Audit log                                                                                          |
  | 14.5 | `MASTER_KEY` rotation under load                                                                   |
  | 15.1 | Guardrail engine                                                                                   |
  | 15.2 | Guardrail policies                                                                                 |
  | 16.1 | Cost against the usage ledger                                                                      |
  | 16.2 | Alerts                                                                                             |
  | 16.3 | Live view                                                                                          |
  | 16.4 | Analytics                                                                                          |
  | 16.5 | Playground                                                                                         |
  | 17.1 | Versioned config                                                                                   |
  | 17.2 | Tracing                                                                                            |

- **Measured in that run:**
  - `MASTER_KEY` rotation re-encrypted 18 secrets (16 credentials, 2 TOTP secrets) from key version 1 to 2 while 1,278 concurrent requests all succeeded.
  - A config rollback reached the gateway in about 40 ms (single gateway replica).
  - A request appeared in the live view about 600 ms after it finished (5 samples, 592–628 ms).
  - The total on the cost page was equal to the usage ledger for 12 requests on a dedicated key.
  - An alert rule fired exactly once in its silence window, and the webhook carried a valid HMAC signature.
- **HA and chaos:** the data tier of the HA overlay was started and drilled (Valkey failover, PostgreSQL promotion, restore drill, base backup and WAL archive); see the drill records in [deploy-ha.md](deploy-ha.md#drill-records). Six chaos scenarios passed on the development stack; see [benchmarks/chaos.md](benchmarks/chaos.md#results).

### Not verified

- **Real Gemini CLI and real Codex CLI sessions.** Only protocol-level requests shaped like those clients were sent, against the mock provider.
- **Provider prompt-cache hit rate** with Claude Code and a real provider.
- **Bedrock, Vertex, Cohere, Voyage and Jina against the real services.** They are covered by unit tests with recorded or handwritten fixtures only. SigV4 and the AWS event-stream decoder are tested against hand-built frames, not live AWS. The Vertex default API version is `v1beta1` and is unconfirmed against live Vertex.
- **The HA overlay behind Traefik** and the **`gateway-replica` chaos scenario**: the full overlay ran with production images (3 gateways, 2 control-api, 2 workers) and each replica was called directly, see the drill records in [deploy-ha.md](deploy-ha.md); behind Traefik the overlay itself has not been run; the `gateway-replica` chaos scenario was measured on the development stack with two replicas (0.32% failed, see [benchmarks/chaos.md](benchmarks/chaos.md)).
- **Point-in-time recovery.**
- **The dashboard pages in a real browser**, including the passkey (WebAuthn) flow. The API contracts are covered by the end-to-end run; UI behaviour is covered by unit tests only.

### Known limitations

- Alert rule types `breaker_open` and `queue_length` are rejected by the API; the worker does not implement them.
- Codex `custom` (free-form) tools such as `apply_patch` are dropped by the Responses translator.
- SSO identities are matched by verified e-mail within the connection's organization; they are not yet bound to `(connection, sub)`.
- SSO connections can only be managed by an organization owner.
- The semantic cache needs a PostgreSQL image with pgvector (`POSTGRES_IMAGE`, `deploy/docker/postgres.Dockerfile`) and `SEMANTIC_CACHE_EMBEDDING_URL`.
- `GET config/versions` lists instance-wide version metadata.

Before a release, run `./scripts/verify/run.sh` (install, generate, typecheck, lint, unit, compose, migrate, integration, e2e) and then `CHAOS=1 ./scripts/verify/run.sh`, and add the chaos and HA drill results to their pages.

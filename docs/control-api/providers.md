[English](providers.md) · [فارسی](providers.fa.md)

# Provider and credential management

Code: `apps/control-api/src/providers` and `apps/gateway/src/probe.ts` · card 3.6

## Endpoints (`/api/v1/orgs/:orgId/providers`)

| route                          | permission        | description                                                                                                                                    |
| ------------------------------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /`, `GET /:id`            | `providers:read`  | list and details; credentials are **masked**                                                                                                   |
| `POST /`                       | `providers:write` | `{name, type, baseUrl?, slug?, proxyUrl?, timeouts?, options?, maxConcurrency?, credentials?: [{name, secret, weight?, headers?, proxyUrl?}]}` |
| `PATCH /:id`, `DELETE /:id`    | `providers:write` | edit; delete is soft and disables the provider                                                                                                 |
| `POST /:id/credentials`        | `providers:write` | add a key                                                                                                                                      |
| `PATCH /:id/credentials/:cid`  | `providers:write` | change name, weight, headers or proxy, `status: ACTIVE/DISABLED`, or **rotation** with a new `secret`                                          |
| `DELETE /:id/credentials/:cid` | `providers:write` | delete a key                                                                                                                                   |
| `POST /:id/test`               | `providers:write` | `{credentialId?}` → `{ok, status, latencyMs, error?, modelCount}`                                                                              |
| `POST /:id/discover`           | `providers:write` | upstream models with `inCatalog` and `suggested`, plus price and context from the catalog if they are known                                    |

Types: `openai`, `anthropic`, `gemini`, `azure-openai` and `openai-compatible` (with `options.preset`, such as groq or openrouter; [providers/](../providers/README.md)). baseUrl has a default for openai, anthropic and gemini. It is required for Azure and compatible services.

## secret

- The secret is entered only once. It is encrypted with **AES-256-GCM** and `MASTER_KEY`, and the AAD is the credential's ID. The storage format is `v<keyVersion>.<base64url>`, and `key_version` is kept separately so the master key can be rotated.
- The API response shows only `••••last4`. From headers, only the names are shown. The proxy password is masked (`socks5h://user:***@…`).
- In the audit log, the `secret` value is replaced with `[REDACTED]`, and the proxy password is masked.
- control-api never decrypts the secret. For tests and discovery, the ciphertext goes to the gateway and is decrypted only in the gateway's memory.

## Connection test and model discovery

```
control-api ──POST /internal/providers/probe (Bearer INTERNAL_TOKEN, provider with encrypted secret)──▶ gateway
gateway: decrypt → adapter.listModelsRequest → the same proxy (credential, provider or global) and the real traffic timeout → GET /models
```

- The result includes `ok`, `status` and `latencyMs`. On error, its class (`auth`, `connection`, `timeout`, …) and a short message are returned, with the proxy password masked.
- **Discovery**: each upstream model is compared with the models of the same provider in the organization's catalog (`models` table). New models get `suggested: true`. If the model is known in the price catalog (`packages/model-catalog`), `catalog.key`, `contextWindow` and the price are also returned, so the dashboard can add it with one click (card 3.8).
- `/internal/providers/probe` returns 404 without the internal token, even through Traefik.
- Gateway address: `GATEWAY_INTERNAL_URL` (default `http://gateway:8080`). With several replicas, DNS spreads the traffic between them.

## Verification (2026-11-07)

- Integration test in control-api (7 cases, on a real Postgres and Valkey, with a fake gateway that records requests):
  - The secret is in no response, and in the DB only the ciphertext is stored.
  - Rotation, disabling and deletion of a key.
  - The gateway receives only the ciphertext.
  - The connection test returns latency, and discovery suggests new models.
  - VIEWER gets 403, and another organization gets 404.
  - **No log line and no audit record contains the secret.**
- Gateway test against a real mock provider: model list and latency for OpenAI-compatible and Anthropic, a wrong key (class `auth`, 401), and a dead proxy (class `connection`, masked password).
- compose through Traefik:
  - A provider was created pointing to the mock, and `••••4242` was shown.
  - The test gave `{ok:true, status:200, latencyMs:8, modelCount:3}`, and discover returned three suggested models.
  - In the logs of all containers, the number of lines containing the secret was zero.

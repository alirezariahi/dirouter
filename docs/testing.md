[English](testing.md) · [فارسی](testing.fa.md)

# End-to-end test — Sprint 1

The script [`scripts/e2e/sprint-1.mjs`](../scripts/e2e/sprint-1.mjs) checks the real development app through Traefik. Requests go to `api.localhost` and `mock.localhost`, and only the seed fixtures are read.

## Running

```bash
cd code
make up
make seed
make e2e              # or: pnpm test:e2e
```

Prerequisites: Node.js 22, Docker Compose and the generated seed credential in `.data/seed-admin.env`. The script logs in to control-api as the development admin user and creates three temporary keys with restricted models. No existing provider, model or key is changed. At the end, the temporary keys are revoked and the stopped services are started again.

> This test intentionally stops and restarts `control-api` and `valkey`; do not run it on production or a shared environment. The gateway and the mock must be running during the test.

## Scenarios

- An Anthropic `/v1/messages` input is translated to a provider of the OpenAI-compatible type; the Anthropic response shape and the body received by the mock are checked.
- A 503 from the primary provider of combo `dev` falls back to a healthy target; observing the 503 and a successful request in the mock is required.
- A 429 in combo `dev-429` only puts `cred_mock-429` into cooldown; the next request passes through the healthy Anthropic provider without retrying that credential.
- A temporary key with a one-token budget gets `billing_error` after a 429 is consumed; an independent key with `rpm=1` rejects the second request with a 429 `rate_limit_error` and the retry/rate-limit headers.
- When control-api is stopped, the gateway keeps responding with the stored snapshot; after it starts, sync becomes healthy again.
- When Valkey is stopped, the successful response stays and the usage is stored in the local outbox; after recovery, exactly one row in `request_log` and one row in `usage_ledger` are created with the same request ID.

The default URLs can be overridden with `E2E_GATEWAY_URL`, `E2E_ADMIN_URL` and `E2E_MOCK_URL`. The service names and the current development database (`org_dev`, `prj_dev`, `dirouter`) are test fixtures.

CI does not run this destructive test on every push. For CI, a dedicated one-time Compose environment must be created and seeded, and then this same command run. The unit/integration tests that do not stop dev services remain in the existing pipeline.

## Local run result

On 8 November 2026 all six scenarios passed on the real dev environment. Gateway and control-api health, and the healthy state of Valkey and the rest, were also checked after cleanup. The temporary keys were revoked. The usage and audit records created by the requests remain, as is normal system behavior.

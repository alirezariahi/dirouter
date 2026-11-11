[English](keys.md) · [فارسی](keys.fa.md)

# Virtual keys

Code: `apps/control-api/src/keys` · test: `keys.integration.test.ts` · card 3.7

## Endpoints (`/api/v1/orgs/:orgId/keys`)

| route                  | permission   | description                                                                                                                                                      |
| ---------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /` and `GET /:id` | `keys:read`  | no raw key; only `prefix` and status (`active`, `rotating`, `expired` or `revoked`)                                                                              |
| `POST /`               | `keys:write` | `{name, projectId, allowedModels?, ipAllowlist?, rpm?, tpm?, maxConcurrency?, expiresAt?, budgets?}`. The response contains the **full key only this one time**. |
| `PATCH /:id`           | `keys:write` | change limits, expiry and budget                                                                                                                                 |
| `POST /:id/revoke`     | `keys:write` | immediate revocation                                                                                                                                             |
| `POST /:id/rotate`     | `keys:write` | `{graceSeconds}` (default 24 hours, maximum 30 days). Returns the new key, together with `previous`.                                                             |

MEMBER can create keys. VIEWER can only view them ([rbac.md](../rbac.md)).

## Format and storage

- The key format is `dr-<prefix>-<secret>`: an 8-character prefix and a 40-character secret, from a 33-letter alphabet without `l`, `0` and `1`, about 200 bits in total.
- The DB stores only the `prefix` (`dr-xxxxxxxx`, for display and lookup) and `HMAC-SHA256(key, KEY_PEPPER)`. **The raw key is not in any table**; a test verifies this by searching for the secret part across all tables.
- The gateway computes the same HMAC and compares it with `timingSafeEqual` ([gateway/auth.md](../gateway/auth.md)).

## Limits

| field                             | enforced in                                                                                          |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `allowedModels`                   | gateway (403 `model_not_allowed`); empty means all                                                   |
| `ipAllowlist`                     | gateway: IP or CIDR in IPv4 and IPv6. Invalid input such as `/33` gets 422.                          |
| `expiresAt`                       | gateway (401 `api_key_expired`); must be in the future                                               |
| `rpm`, `tpm` and `maxConcurrency` | rate limiter (card 6.1)                                                                              |
| `budgets`                         | each period (`daily` or `monthly`) with `limitUsd` or `limitTokens` and `alertThresholds` (card 6.3) |

## Revocation and rotation

- **Revocation** sets `status=REVOKED`, and the key is removed from the next snapshot. The gateway learns about it immediately through `config:updated` ([config-sync.md](config-sync.md)).
- **Rotation** creates a new key with the same settings, limits and budget. The old key gets `expiresAt = now + graceSeconds` and `rotatedToId`, so it **keeps working until the grace period ends**, and then gets 401. A revoked, expired or already rotated key cannot be rotated again (409).

## Check in compose (2026-11-07)

| step                                     | time until applied at the gateway                                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| create key, until the first 200          | 48 to 76 ms                                                                                                                                                               |
| revoke, until the first 401 (three runs) | 140, 125 and 140 ms                                                                                                                                                       |
| rotate with a 4-second grace             | the new key worked after 59 ms, and the old key got 200 within the grace period. 48 ms after the grace period ended, the old key got 401 while the new key still got 200. |

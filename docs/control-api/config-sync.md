[English](config-sync.md) · [فارسی](config-sync.fa.md)

# Config Snapshot and gateway synchronization

Code: `apps/control-api/src/snapshot` and `apps/gateway/src/config-store.ts` · cards 3.9 and 4.2

```
dashboard/API ──successful change under /orgs/──▶ control-api: rebuild (debounce 50ms)
                                         │ fresh checksum? → config_versions (version++)
                                         └─ PUBLISH dirouter:config:updated <version>
gateway ◀── SUBSCRIBE ── immediately GET /internal/config/snapshot (If-None-Match)
gateway ◀── the same GET every 2 seconds (fallback when Valkey is down) → 304 if nothing changed
gateway: zod validation → atomic swap in memory → save to disk (boot without control-api)
```

## Snapshot

- **All organizations** in one snapshot: providers with **encrypted** credentials, models and prices, combos, aliases, active keys (hash only), the limits and budgets of projects, teams and keys, and settings.
- **Contains no plain secrets.** Secrets are decrypted only in the gateway's memory with MASTER_KEY. Revoked or expired keys are not in the snapshot.
- The content is serialized with sorted keys, and its checksum (SHA-256) changes only with a real change. So a rebuild without a change does not create a new version.
- `config_versions`: the version number is incremental (`SERIAL`), and the last 50 versions are kept. An advisory lock prevents simultaneous builds across several control-api replicas.
- **What triggers a rebuild**: every successful non-GET request (status below 400) under `/api/v1/orgs/` (provider, credential, model, alias, combo, key, project, etc.), and the control-api startup.

## Internal endpoint

`GET /internal/config/snapshot` with `Authorization: Bearer $INTERNAL_TOKEN`:

- Without the token, it returns 404.
- It has `ETag: "v<version>-<checksum16>"`. With a matching `If-None-Match`, the response is **304 with no body**.

## Gateway

- The snapshot received from control-api is the **source of truth**: any different version is accepted, for example after a DB restore or the replacement of a test snapshot in dev. The disk version is applied only if it is newer.
- An invalid snapshot is rejected and logged, and the current config stays in place (card 4.2).
- Without control-api, the gateway starts from the last valid snapshot on disk.

## Verification (2026-11-07)

- Integration in control-api:
  - The version increases with each change and is announced on Valkey.
  - A rebuild without a change does not create a version.
  - ETag and 304 work, and the schema is valid.
  - No plain-text secret is in the snapshot.
  - A revoked key is removed in the next version.
  - Without a token: 404.
- compose (a change in control-api until its effect in the gateway):
  - A fresh key became usable after 48 to 186 ms.
  - Revocation was applied after 125 to 140 ms.
  - With Valkey stopped, the change arrived via the periodic poll (155 ms in this run, and in the worst case about 2 seconds).

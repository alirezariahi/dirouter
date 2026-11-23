[English](upgrade-v1.md) · [فارسی](upgrade-v1.fa.md)

# Upgrading to v1.0

From any 0.x installation, including the MVP (end of sprint 1), to 1.0.0. The upgrade is tested in
CI on real data: `apps/control-api/src/upgrade/upgrade-from-mvp.integration.test.ts` applies the
MVP's migrations, writes data in the MVP's schema, upgrades, and checks that the owner can sign in
with the same password, every record is intact, provider credentials still decrypt and the gateway
snapshot is built.

## Before you start

1. **Back up PostgreSQL** (`scripts/backup/` or your provider's snapshot) and keep a copy of your
   `.env`, above all `MASTER_KEY` and `KEY_PEPPER`. They must not change: stored provider
   credentials are encrypted with `MASTER_KEY`, and virtual keys are hashed with `KEY_PEPPER`.
2. Verify the new images' signatures ([SECURITY.md](../SECURITY.md)).

## Upgrade

With Docker Compose:

```bash
TAG=1.0.0 docker compose pull
```

```bash
TAG=1.0.0 docker compose up -d
```

The `migrate` service applies the new migrations before control-api starts. With Helm, run
`helm upgrade` with the new chart; control-api's init container migrates
([helm.md](helm.md)). Gateways keep serving from their last snapshot while control-api restarts
(ADR-0006).

## What changes on its own

- The oldest organization becomes the **platform organization** (the operator), which owns billing,
  the model marketplace and the system wallets. Other organizations become its customers.
- Existing organizations stay **postpaid** (`prepaid` is false), so their traffic is not
  interrupted. A wallet is created the first time an organization is credited or used; switch an
  organization to prepaid when you are ready.
- Four-eyes approval, SAML, SCIM, plugins and media endpoints are all off until configured.

## New, optional settings

All new environment variables have safe defaults; see [env-reference.md](env-reference.md). The
ones worth reviewing: `PUBLIC_GATEWAY_URL` and `PUBLIC_PORTAL_URL` (links in generated agent
configurations and the portal), payment provider keys, `PLUGINS_ENABLED`.

## Rolling back

Restore the database backup and start the previous images. Migrations are forward-only.

# Kubernetes with Helm

The chart in `deploy/helm/dirouter` (card 22.6) runs the gateway, control-api, worker, dashboard
and portal. Every value is described in `deploy/helm/dirouter/values.yaml`.

## Install

```bash
helm install dirouter deploy/helm/dirouter --namespace dirouter --create-namespace \
  --set domain=example.com \
  --set database.url='postgresql://dirouter:<password>@db.internal:5432/dirouter' \
  --set valkeyUrl=redis://valkey.internal:6379
```

For a quick evaluation, `--set postgresql.enabled=true --set valkey.enabled=true` runs
single-instance PostgreSQL and Valkey inside the release instead. Use managed, replicated services
in production ([deploy-ha.md](deploy-ha.md)).

## What the chart does

- **Gateway:** a Deployment with a HorizontalPodAutoscaler on CPU (2 to 10 replicas by default) and
  a PodDisruptionBudget. Rolling updates add a pod before removing one, and the grace period covers
  the gateway's drain ([ADR-0007](../adr/0007-data-plane-stays-on-node.md) gives the per-replica
  load to plan for). It gets no database credentials (ADR-0006).
- **control-api:** runs the database migrations in an init container before it starts (Prisma's
  advisory lock makes concurrent replicas safe), with a PodDisruptionBudget.
- **Probes:** readiness on `/readyz` and liveness on `/healthz` for every service.
- **Secrets:** `MASTER_KEY`, `KEY_PEPPER`, `JWT_SECRET` and `INTERNAL_TOKEN` are generated on first
  install and kept on every upgrade; the Secret is also kept if the release is uninstalled. Back it
  up: stored provider credentials cannot be read without `MASTER_KEY`. To manage them yourself, set
  `secrets.existingSecret`.
- **Traefik:** an IngressRoute for `api.`, `admin.`, `app.` and `portal.` hosts when the Traefik
  CRDs are installed (TLS from `ingressRoute.certResolver` or `ingressRoute.tlsSecret`). Without
  them, expose the services with your own ingress.
- **Security:** pods run as non-root with no capabilities, no privilege escalation and the default
  seccomp profile.

## Verification

CI installs the chart on a kind cluster with images built from the same commit, waits for every pod
to be ready, checks `/readyz` on the gateway and control-api, then upgrades the release and checks
that the generated keys did not change. A failure writes pod status, events and logs to the run's
summary.

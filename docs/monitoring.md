[English](monitoring.md) · [فارسی](monitoring.fa.md)

# Monitoring with Prometheus and Grafana

The optional `monitoring` profile scrapes four targets every 15 seconds: the gateway on `8080`, control-api on `3000`, the worker on `3100`, and Traefik on `8082`. The Traefik port is the internal `traefik` entryPoint in the static configuration; `8080` is the gateway port, not Traefik. None of the `/metrics` endpoints are published through public Traefik.

Prometheus has access to the `internal` network so it can read worker metrics. Grafana is only on `edge` and queries through the internal address `http://prometheus:9090`; Grafana has no direct access to the worker or Postgres. The dashboard, datasource and alert rules are provisioned from files and stay in Git so changes can be reviewed.

## Running in development

Set a separate, strong admin password for Grafana in `code/.env` (the default password or `admin/admin` is not allowed):

```dotenv
GRAFANA_ADMIN_PASSWORD=<a-long-random-password>
```

Then:

```bash
make bootstrap # only if code/.env does not exist yet
docker compose -f compose.yaml -f compose.dev.yaml \
  --profile monitoring up -d --wait
```

- Grafana: <http://127.0.0.1:53000>; the default username is `admin` and the password is `GRAFANA_ADMIN_PASSWORD`. Change the password after the first login.
- Prometheus: <http://127.0.0.1:59090>; scrape status can be checked under **Status → Targets** and rules under **Alerts**.
- The **DiRouter — Operations overview** dashboard is created automatically in the **DiRouter** folder. The default datasource is `Prometheus`, and the queries need no manual setup.

To change the localhost ports, set `GRAFANA_PORT` and `PROMETHEUS_PORT`. These ports are deliberately bound only to `127.0.0.1`; for remote access use an SSH tunnel or an authenticated reverse proxy with TLS. Do not publish the Grafana password in a URL, in logs, or in the output of `docker compose config`.

## Running in production

The monitoring files are in the same Compose project; CPU/RAM limits and log rotation are applied in `compose.prod.yaml`:

```bash
docker compose -f compose.yaml -f compose.prod.yaml \
  --profile monitoring up -d --wait
```

Prometheus data is kept in the named volume `prometheus-data`, and Grafana settings/users in `grafana-data`. The default TSDB retention is fifteen days and can be changed with `PROMETHEUS_RETENTION` (for example `30d`). Check disk capacity against the number of replicas, labels and retention; a backup of the dashboard alone is not a backup of the metric history.

To publish Grafana safely in production, keep the bind on localhost and connect through SSH or organizational access control. If you expose it on a public network, you must provide TLS, strong authentication (preferably SSO), a network allowlist and a separate backup policy. The metrics contain no prompts or secrets, but they reveal operational status and provider/model names, so they are not considered public.

## Dashboard and alerts

The dashboard shows request rate and error ratio, p95/p99 latency, TTFT, open streams, the usage outbox, queue state, worker jobs, control-api requests and Traefik HTTP responses. The base alerts in `deploy/monitoring/alerts/dirouter.yml` are:

- Scrape outage of all four targets, and failure to collect queue state from Valkey;
- Gateway error rate above 10%, p95 above 30 seconds, outbox growth above 1000 events, and an open breaker;
- Queue backlog above 1000 jobs, usage events dead-lettered, and error rate above 10% in worker jobs.

The rules have a minimum request/job rate so they do not alert on near-zero traffic. Tune the thresholds to your SLO and real traffic pattern; the current values are operational starting points.

> Prometheus only evaluates the rules and shows the `pending`/`firing` state. Sending to Slack, email or PagerDuty requires Alertmanager, which does not run in this profile. For external alerting, add Alertmanager and `alerting.alertmanagers` to your deployment. Do not use legacy Grafana notification channels to replace this path.

## Changing and validating configuration

```bash
# Render and validate both environments (put the required secret in .env)
docker compose -f compose.yaml -f compose.dev.yaml --profile monitoring config --quiet
docker compose -f compose.yaml -f compose.prod.yaml --profile monitoring config --quiet

# Check the configuration syntax and all rules, without running a server
docker run --rm \
  -v "$PWD/deploy/monitoring:/etc/dirouter-monitoring:ro" \
  prom/prometheus:v3.7.3 \
  --entrypoint promtool \
  check config /etc/dirouter-monitoring/prometheus.yml
docker run --rm \
  -v "$PWD/deploy/monitoring:/etc/dirouter-monitoring:ro" \
  prom/prometheus:v3.7.3 \
  --entrypoint promtool \
  check rules /etc/dirouter-monitoring/alerts/dirouter.yml
```

After changing `prometheus.yml` or the rules, apply the new configuration by reloading the service or with `POST /-/reload` (because `--web.enable-lifecycle` is enabled). The dashboards and datasources are kept in these files:

```text
deploy/monitoring/prometheus.yml
deploy/monitoring/alerts/dirouter.yml
deploy/monitoring/grafana/provisioning/datasources/prometheus.yml
deploy/monitoring/grafana/provisioning/dashboards/dirouter.yml
deploy/monitoring/grafana/dashboards/dirouter-overview.json
```

The full list of metrics, the label contract and sample queries are in [observability.md](observability.md). For troubleshooting, first check Grafana's `/api/health`, Prometheus's `/-/healthy`, and then **Status → Targets**. `dirouter_queue_metrics_up=0` with `up=1` means a problem reading Valkey, not an outage of the endpoint itself.

[English](observability.md) · [فارسی](observability.fa.md)

# Observability and correlation

This document is the contract for cards 8.1 and 8.2. The gateway, control-api and worker expose Prometheus text output at `GET /metrics`. The endpoints are on the same port as the service (`8080`, `3000` and `3100` in compose). In production, scraping must be done only from the internal network; these endpoints should generally not be published through Traefik.

## Shared rules

- All durations are **seconds**; histogram names end with `_seconds`.
- Each process has its own registry and runtime prefix: `dirouter_gateway_`, `dirouter_control_api_` and `dirouter_worker_`.
- No label exists for request id, end user, organization, project, team, virtual key, credential, IP or prompt.
- In the gateway, provider and model are the stable snapshot values (`providerId` and `modelId`). A request rejected before it is resolved gets `provider="none"`, and model is only the requested model name from the schema; it is never the prompt text or the error.
- For scrape health, use `dirouter_queue_metrics_up`. A Valkey error during a scrape is capped at two seconds and does not break the endpoint.

## Gateway

| Metric                                               | Type      | Labels                                | Meaning                                                                                                                                             |
| ---------------------------------------------------- | --------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dirouter_gateway_requests_total`                    | Counter   | `provider`, `model`, `status`         | All LLM requests, including rejections before upstream; status is only `success`/`error`                                                            |
| `dirouter_gateway_request_duration_seconds`          | Histogram | `provider`, `model`                   | Full request latency                                                                                                                                |
| `dirouter_gateway_ttft_seconds`                      | Histogram | `provider`, `model`                   | Time to the first byte of a stream response; only when TTFT is available                                                                            |
| `dirouter_gateway_request_attempts`                  | Histogram | `provider`, `model`                   | Number of real upstream attempts; skipped candidates are not counted                                                                                |
| `dirouter_gateway_upstream_attempt_duration_seconds` | Histogram | `provider`, `model`, `outcome`        | Duration of each attempt, attributed to that attempt                                                                                                |
| `dirouter_gateway_admission_rejected_total`          | Counter   | `guard`, `reason`                     | Rejection by rate limit, budget or concurrency; reason is only fixed enums such as `requests`, `tokens`, `concurrency`, `usd`, `unavailable`, `key` |
| `dirouter_gateway_active_streams`                    | Gauge     | —                                     | Open streams from admission until end/abort                                                                                                         |
| `dirouter_gateway_usage_outbox_events`               | Gauge     | —                                     | Number of buffered in-memory events plus NDJSON lines remaining in the local outbox; read at scrape time                                            |
| `dirouter_gateway_breaker_state`                     | Gauge     | `scope`, `provider`, `model`, `state` | Value 1 for `open`/`half_open` and 0 for `closed`; scope=`provider` or `model`                                                                      |

For a model breaker, the provider label is filled in when it exists in the snapshot. For a provider breaker, the model label is empty. To search for an open state independent of the state label:

```promql
dirouter_gateway_breaker_state{state=~"open|half_open"} == 1
```

The default Node.js metrics with the `dirouter_gateway_` prefix also exist.

## Control API

| Metric                                          | Type      | Labels                           | Meaning                                                                                                                                   |
| ----------------------------------------------- | --------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `dirouter_queue_jobs`                           | Gauge     | `queue`, `state`                 | Number of jobs in the `usage`, `usage-dead` and `maintenance` queues, in the states `waiting`, `active`, `delayed`, `failed`, `completed` |
| `dirouter_queue_metrics_up`                     | Gauge     | —                                | Success of the last queue state read; 1 means all queues were read                                                                        |
| `dirouter_control_api_request_duration_seconds` | Histogram | `method`, `route`, `status_code` | Duration of management requests; the route is the Fastify pattern, not a URL with an id                                                   |

This service creates a dedicated metrics connection for reading BullMQ and closes it at shutdown. Runtime metrics have the `dirouter_control_api_` prefix.

## Worker

| Metric                                 | Type      | Labels           | Meaning                                                                                                                              |
| -------------------------------------- | --------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `dirouter_queue_jobs`                  | Gauge     | `queue`, `state` | Queue lengths; same contract as control-api                                                                                          |
| `dirouter_queue_metrics_up`            | Gauge     | —                | Health of queue length collection                                                                                                    |
| `dirouter_usage_events_written_total`  | Counter   | —                | Usage events successfully written by the writer                                                                                      |
| `dirouter_usage_events_failed_total`   | Counter   | —                | Failed event write attempts                                                                                                          |
| `dirouter_usage_events_dead_total`     | Counter   | —                | Events moved to the dead-letter queue                                                                                                |
| `dirouter_worker_job_duration_seconds` | Histogram | `job`, `outcome` | Duration of the `usage`, `rollup`, `partitions`, `retention`, `budget-alerts` and `budget-reconcile` jobs; outcome=`success`/`error` |

Runtime metrics have the `dirouter_worker_` prefix. The name `dirouter_worker_job_duration_seconds` is the same for usage and maintenance so that one query covers all job durations.

## Sample queries

```promql
# Gateway error rate by provider (five minutes)
sum by (provider) (rate(dirouter_gateway_requests_total{status="error"}[5m]))
  / clamp_min(sum by (provider) (rate(dirouter_gateway_requests_total[5m])), 0.000001)

# p99 request latency
histogram_quantile(0.99,
  sum by (le, provider, model) (rate(dirouter_gateway_request_duration_seconds_bucket[5m])))

# p95 TTFT
histogram_quantile(0.95,
  sum by (le, provider, model) (rate(dirouter_gateway_ttft_seconds_bucket[5m])))

# Usage backlog and queue collection outage
dirouter_gateway_usage_outbox_events
sum by (queue) (dirouter_queue_jobs{state=~"waiting|delayed|active"})
dirouter_queue_metrics_up == 0
```

The initial alert must cover, in addition to the error rate, outbox growth, queue backlog, `dirouter_queue_metrics_up == 0`, and an open breaker.

## Correlation with X-Request-Id

1. Traefik keeps the incoming `X-Request-Id` header.
2. The gateway and control-api accept a valid incoming value (`[\w.-]{1,128}`); otherwise they generate `req_<ULID>`.
3. The same value is returned in the `X-Request-Id` response header; it remains in streams and errors.
4. In the gateway, the JSON field `requestId` in the logs and the `requestId` of the usage event are the same value.
5. The UsageSink gives the event to BullMQ with `idempotencyKey=requestId`. After parsing, the worker writes the same `requestId` in the `usage event written` log, or in the write error. The dead-letter also has this field if the event is valid.

Therefore, searching for a request id in log aggregation should show the `request completed` log in the gateway and the `usage event written` log in the worker together. The control-api also has a `request` log with the `requestId`, method, URL, status and duration for each HTTP response.

Example JSON (time/level/pid fields removed):

```json
{"service":"gateway","requestId":"req_abc","msg":"request completed","status":"success","httpStatus":200,"provider":"prv_openai","model":"mdl_gpt","stream":true,"latencyMs":312,"ttftMs":74,"attempts":1}
{"service":"worker","requestId":"req_abc","msg":"usage event written","jobId":"req_abc","status":"written","latencyMs":312}
```

## Log privacy

- The gateway's completion log is an allowlist of metadata: request id, status, HTTP status, provider/model id, stream, latency/TTFT, number of attempts and a fixed error code.
- The worker log also has only the request/job id, the result and the latency; the whole event is not serialized.
- Prompts, responses, messages, tool arguments, bodies, credentials, endUser and organization/project/key ids are not logged by default.
- Pino redacts known sensitive fields such as authorization, api key, cookie, secret, password and token. Redaction does not replace the allowlist: a new field must be reviewed before it is added to a log.
- Upstream errors may contain provider text and appear in server error logs; a user's request or response body is deliberately not added to exceptions or logs. The default level is `info`, and raising it to `debug` does not enable prompt logging either.
- The usage event and Postgres hold the metadata needed for cost calculation and the logs page. This data is not the same as "structured logging", and the whole event should not be printed to logs.

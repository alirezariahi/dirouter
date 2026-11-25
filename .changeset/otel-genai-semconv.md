---
'@dirouter/gateway': minor
'@dirouter/contracts': minor
---

OpenTelemetry: gateway spans now follow the GenAI semantic conventions (v1.41.0): each upstream
attempt is a CLIENT span named `{operation} {model}` with `gen_ai.operation.name`,
`gen_ai.provider.name`, request and response model, finish reasons and token usage, so Langfuse,
Phoenix or Datadog show it as an LLM call without a custom mapping. The original `gateway.*`
names are kept by default (`tracing.attributes: both`); `gen_ai` drops them and `legacy` restores
the previous span names. New `tracing.metrics` and `tracing.logs` settings export the metrics
registry (with `gen_ai.client.token.usage` and `gen_ai.client.operation.duration`) and the log
lines over OTLP/HTTP. The upstream span is no longer named `gateway.upstream` unless `legacy` is
chosen; update trace queries that match that name.

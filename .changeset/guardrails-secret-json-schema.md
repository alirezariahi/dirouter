---
'@dirouter/gateway': minor
'@dirouter/control-api': minor
'@dirouter/contracts': minor
'@dirouter/dashboard': minor
---

Guardrails: `secret` and `json_schema` policies are now enforced by the gateway on requests,
answers and streams. Before this release the gateway skipped both types without a word, although
they could be created and passed the live test; review existing `secret` and `json_schema`
policies with `action: block` before upgrading. The live test now runs the gateway's own engine,
`json_schema` schemas are validated when saved, and a policy of an unknown type is logged and
counted in `dirouter_gateway_guardrail_unknown_total` instead of being ignored silently.

[English](guardrails.md) · [فارسی](guardrails.fa.md)

# Guardrails

> Code: `packages/contracts/src/guardrail-engine.ts` (the engine, shared by the gateway and the live test), `apps/gateway/src/guardrails.ts` (streaming), `packages/contracts/src/guardrails.ts`, `apps/control-api/src/guardrails` (cards 15.1, 15.2 and 23.1). Dashboard: **Guardrails**.

A guardrail is a rule the gateway evaluates on the request (before routing) or on the response (before it is returned). Policies travel in the config snapshot, so evaluation needs no network call.

## Policy

| Field     | Values                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------- |
| `stage`   | `request`, `response`, `both`                                                                           |
| `type`    | `regex`, `keyword`, `pii`, `secret`, `prompt_injection`, `max_input_tokens`, `json_schema`              |
| `action`  | `block` (reject with `content_filter`), `redact` (replace the match with `[REDACTED]`), `flag` (record) |
| `config`  | depends on the type, see below                                                                          |
| `message` | text returned to the client on a block (optional)                                                       |
| scope     | organization-wide, or limited with `projectId` / `virtualKeyId`                                         |

| Type               | `config`                                                       | Notes                                                                                                                              |
| ------------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `regex`            | `pattern`, optional `flags`                                    | compiled once and cached; an invalid pattern is ignored instead of failing requests                                                |
| `keyword`          | `terms` (array or comma list), `caseSensitive`                 | literal match                                                                                                                      |
| `pii`              | `type`: `email`, `credit_card`, `iban`, `national_id`, `phone` | card numbers must pass the **Luhn** check and national IDs the Iranian **mod-11** check digit, so ordinary numbers are not flagged |
| `secret`           | none                                                           | provider tokens, API keys and private-key material; see [Secrets](#secrets)                                                        |
| `prompt_injection` | none                                                           | heuristic score over instruction-override patterns; fires at score 2 or more                                                       |
| `max_input_tokens` | `maxTokens`                                                    | request stage; compares the estimated input size                                                                                   |
| `json_schema`      | `schema`                                                       | response stage only; the answer must parse as JSON and satisfy the schema, see [JSON Schema](#json-schema)                         |

Policies run in order; the first blocking policy stops evaluation. Hits (policy, type, action, match count) are written to the gateway log (`guardrail hits`) for requests, answers, streams and cached answers; matched text is not.

> **Before v1.1 (card 23.1)** the gateway skipped `secret` and `json_schema` policies without a word: they could be created and passed the live test, but real traffic was never checked. Since v1.1 they are enforced. Review existing `secret` and `json_schema` policies with `action: block` before upgrading: requests or answers they match are now rejected.

## Secrets

The `secret` type looks for credentials with a fixed prefix and a key-sized body, so ordinary prose does not match:

| Detector                  | Example shape                                            |
| ------------------------- | -------------------------------------------------------- |
| OpenAI and Anthropic keys | `sk-…`, `sk-proj-…`, `sk-ant-…` (at least 20 characters) |
| DiRouter virtual keys     | `dr-xxxxxxxx-…` (40 characters)                          |
| AWS access key ids        | `AKIA…`, `ASIA…`                                         |
| GitHub tokens             | `ghp_…`, `gho_…`, `ghs_…`, `github_pat_…`                |
| Slack tokens              | `xoxb-…`, `xoxp-…`                                       |
| Google API keys           | `AIza…`                                                  |
| Stripe keys               | `sk_live_…`, `rk_test_…`                                 |
| JWTs                      | `eyJ….eyJ….…`                                            |
| PEM private keys          | `-----BEGIN … PRIVATE KEY-----` through the END line     |

A PEM key is treated as one block: with `redact` the whole block becomes one `[REDACTED]`. A key with no END line (an answer cut off by `max_tokens`) is redacted from its BEGIN line to the end. The live test shows only the first eight characters of each match.

## JSON Schema

A `json_schema` policy checks the model's answer, not the prompt; on the request stage it does nothing. The answer must be JSON (one surrounding Markdown fence such as ` ```json ` is allowed) and must satisfy `config.schema`.

Supported keywords: `type` (one or a list), `enum`, `const`, `properties`, `required`, `additionalProperties`, `items`, `minItems`, `maxItems`, `minLength`, `maxLength` (in code points), `pattern`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `anyOf`, `oneOf`, `allOf`. Annotations (`title`, `description`, `$schema`, `format`, `default`, `examples`, …) are accepted and ignored.

The schema itself is checked when the policy is saved: any other keyword (for example `$ref` or `if`), an unknown type, or a `pattern` that could backtrack catastrophically is refused with `400`. That way a schema can never be stored that the gateway would only half enforce.

`block` rejects a non-conforming answer; `flag` lets it through and records the hit with the number of problems; `redact` has no meaning for a document and behaves like `flag`. The provider has already answered (and is billed) when the answer is checked.

## Unknown policy types

A policy whose type this gateway does not enforce (for example one added by a newer control plane during a rolling upgrade) is skipped, never silently: the gateway logs `guardrail policy of an unknown type was not enforced` at `warn` with the policy id and type, and counts it in `dirouter_gateway_guardrail_unknown_total{type}`. The snapshot stays valid; only that policy is skipped.

## Streaming

Response policies also apply to streams (`StreamGuardrailBuffer`):

- Only **complete words** are evaluated. The word still being received is held back, because matching it early would redact `user@example.co` and then leak the `m` that arrives in the next chunk.
- The last 256 characters of evaluated text are held back too, so multi-word patterns that continue in later chunks still match; text is released only at a whitespace boundary. A piece sent to the client therefore never ends in the middle of a word.
- A blocking match ends the stream with a `content_filter` error event; nothing after it is sent. At the end of the stream the held-back tail is evaluated once more.
- A run with no whitespace longer than four windows (1024 characters) is evaluated and released anyway, to bound memory and delay.
- With a `secret` policy, a PEM private key is held from its BEGIN line until its END line arrives (up to 16 KB), so no line of the key leaks before the whole block is matched.
- A `json_schema` policy with `block` holds the **whole answer** until it is complete, then judges it; a failing answer ends the stream with the error event and none of its text is sent. With `flag` the text flows normally and the verdict is recorded when the text ends.

The price is latency: stream text reaches the client about 256 characters late while a response policy is active. Streams without response policies are not buffered at all.

## Overhead

`guardrails.test.ts` measures a regex policy on a 4 KB prompt: about **0.003 ms** per check on the development machine, against a budget of 1 ms.

## Testing a policy before saving

`POST /orgs/:orgId/guardrails/test` with `{type, action, config, text}` returns whether the text would be blocked (`blocked`), whether the policy matched at all (`hit`, also for `flag`), the matches and the redacted text, without storing anything. For `json_schema` the text is treated as the model's answer and the response adds `valid` and `schemaErrors`. The dashboard form has a **Live test** box that uses it.

The live test runs the gateway's own engine (`packages/contracts/src/guardrail-engine.ts`), so its verdict is the verdict in real traffic. A shared table of cases, `packages/contracts/src/__fixtures__/guardrails/conformance.json`, is run by both the gateway tests (request, answer and stream) and the control-plane tests; a change that makes them disagree fails CI.

## Management API

`GET|POST /orgs/:orgId/guardrails`, `PATCH|DELETE /orgs/:orgId/guardrails/:id` (permissions `guardrails:read` / `guardrails:write`). Changes are published to the gateways as a new config version and written to the audit log.

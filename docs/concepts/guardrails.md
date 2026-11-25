[English](guardrails.md) · [فارسی](guardrails.fa.md)

# Guardrails

> Code: `packages/contracts/src/guardrail-engine.ts` (the engine, shared by the gateway and the live test), `apps/gateway/src/guardrails.ts` (streaming), `packages/contracts/src/guardrails.ts`, `apps/control-api/src/guardrails` (cards 15.1, 15.2 and 23.1). Dashboard: **Guardrails**.

A guardrail is a rule the gateway evaluates on the request (before routing) or on the response (before it is returned). Policies travel in the config snapshot, so evaluation needs no network call.

## Policy

| Field     | Values                                                                                                   |
| --------- | -------------------------------------------------------------------------------------------------------- |
| `stage`   | `request`, `response`, `both`                                                                            |
| `type`    | `regex`, `keyword`, `pii`, `secret`, `prompt_injection`, `max_input_tokens`, `json_schema`, `moderation` |
| `action`  | `block` (reject with `content_filter`), `redact` (replace the match with `[REDACTED]`), `flag` (record)  |
| `config`  | depends on the type, see below                                                                           |
| `message` | text returned to the client on a block (optional)                                                        |
| scope     | organization-wide, or limited with `projectId` / `virtualKeyId`                                          |

| Type               | `config`                                                       | Notes                                                                                                                              |
| ------------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `regex`            | `pattern`, optional `flags`                                    | compiled once and cached; an invalid pattern is ignored instead of failing requests                                                |
| `keyword`          | `terms` (array or comma list), `caseSensitive`                 | literal match                                                                                                                      |
| `pii`              | `type`: `email`, `credit_card`, `iban`, `national_id`, `phone` | card numbers must pass the **Luhn** check and national IDs the Iranian **mod-11** check digit, so ordinary numbers are not flagged |
| `secret`           | none                                                           | provider tokens, API keys and private-key material; see [Secrets](#secrets)                                                        |
| `prompt_injection` | optional `classifier`                                          | English and Persian instruction-override patterns, plus an optional classifier model; see [Prompt injection](#prompt-injection)    |
| `max_input_tokens` | `maxTokens`                                                    | request stage; compares the estimated input size                                                                                   |
| `json_schema`      | `schema`                                                       | response stage only; the answer must parse as JSON and satisfy the schema, see [JSON Schema](#json-schema)                         |
| `moderation`       | `model`, `mode`, `thresholds`, `timeoutMs`, `failMode`         | a moderation model judges the text through the gateway; see [Moderation](#moderation)                                              |

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

## Moderation

A `moderation` policy (card 23.2, since v1.1) sends the text to a moderation model. The call goes **through the gateway itself** with the caller's own key: it is routed (with fallback), rate limited, charged to the wallet and recorded in usage like any request, under its own request id (`<request id>-guard-request-0`). It does not take a second slot of the key's concurrency cap. The key must be allowed to use the moderation model.

| `config`     | Meaning                                                                                                                                                                                                                                                   | Default       |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `model`      | model or alias of the moderation model (required)                                                                                                                                                                                                         |               |
| `mode`       | `moderations`: an OpenAI-compatible `/moderations` endpoint (OpenAI `omni-moderation-latest`, or any server with that API); `llama_guard`: a chat model that answers `safe` or `unsafe` plus category codes (Llama Guard served by vLLM, Groq, Together…) | `moderations` |
| `thresholds` | category → minimum score, e.g. `{"violence": 0.7, "hate": 0.5}`. Only the listed categories count. Without it the provider's own `flagged` decides. For `llama_guard` it lists the codes that count (`{"S1": 1}`)                                         | none          |
| `timeoutMs`  | how long the gateway waits for the verdict (50–30000)                                                                                                                                                                                                     | `2000`        |
| `failMode`   | `open`: when the model times out or fails, the request passes; `closed`: it is rejected                                                                                                                                                                   | `open`        |

`block` rejects with `content_filter`; `flag` records the hit with the categories; `redact` behaves like `flag`. With `stage: both` the request is checked before routing and the answer after it. In a stream with `block` the whole answer is held until it is complete and then judged; with `flag` the text flows and the verdict is recorded at the end.

Clients can call the same moderation models directly with `POST /v1/moderations` (OpenAI format).

Every call is counted in `dirouter_gateway_guardrail_calls_total{type, outcome}` (`pass`, `flagged`, `timeout`, `error`); a timeout or failure is also logged at `warn` (`guardrail model call timed out` / `failed`).

The live test in the panel makes no model calls: for these policies it says so (`needsModelCall`), and the verdict only applies to real traffic.

## Prompt injection

The built-in patterns (card 23.3) cover English and Persian: instructions to ignore, forget or override earlier instructions; requests to reveal the system prompt; role switches to an unrestricted mode (DAN, developer mode, jailbreak); fake role tags (`</system>`, `<|im_start|>`); text addressed to the AI inside a document or tool output; and requests to send keys or the conversation to an address. Strong signals score 2 and weak ones 1; the policy fires at 2, so a weak signal alone ("you are now", a role tag) does not block. Tool results (`tool_result`) are scanned as untrusted input like user messages.

`packages/contracts/src/__fixtures__/guardrails/prompt-injection.json` holds 50 attacks and 50 benign texts, half English and half Persian, including near misses such as "ignore the outliers" or how to turn on Android's developer mode. `guardrail-engine.injection.test.ts` prints the rates and fails CI below 90% detection or above 4% false positives per language. Currently: English 100% detection and 0% false positives, Persian 100% and 0%. The set was written together with the patterns, so these numbers show the patterns cover the set, not how they do on unseen attacks; the classifier is for what patterns miss.

The optional classifier asks a small chat model as well:

```json
{
  "classifier": {
    "model": "my-small-model",
    "threshold": 0.5,
    "timeoutMs": 2000,
    "failMode": "open"
  }
}
```

The model is asked to answer `{"injection": true|false, "score": 0..1}`; a score at or above `threshold` counts like a strong pattern. The call goes through the gateway like a moderation call, with the same timeout and `failMode` rules (`open` by default: the patterns still apply when the classifier is down).

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

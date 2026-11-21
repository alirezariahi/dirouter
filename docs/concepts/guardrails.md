[English](guardrails.md) · [فارسی](guardrails.fa.md)

# Guardrails

> Code: `apps/gateway/src/guardrails.ts`, `packages/contracts/src/guardrails.ts`, `apps/control-api/src/guardrails` (cards 15.1 and 15.2). Dashboard: **Guardrails**.

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
| `secret`           | none                                                           | provider tokens, API keys and private-key material                                                                                 |
| `prompt_injection` | none                                                           | heuristic score over instruction-override patterns; fires at score 2 or more                                                       |
| `max_input_tokens` | `maxTokens`                                                    | request stage; compares the estimated input size                                                                                   |
| `json_schema`      | `schema`                                                       | response stage; the text must parse and satisfy a small JSON Schema subset                                                         |

Policies run in order; the first blocking policy stops evaluation. Hits (policy, type, action, match count) are recorded with the request; matched text is not.

## Streaming

Response policies also apply to streams (`StreamGuardrailBuffer`):

- Only **complete words** are evaluated. The word still being received is held back, because matching it early would redact `user@example.co` and then leak the `m` that arrives in the next chunk.
- The last 256 characters of evaluated text are held back too, so multi-word patterns that continue in later chunks still match; text is released only at a whitespace boundary. A piece sent to the client therefore never ends in the middle of a word.
- A blocking match ends the stream with a `content_filter` error event; nothing after it is sent. At the end of the stream the held-back tail is evaluated once more.
- A run with no whitespace longer than four windows (1024 characters) is evaluated and released anyway, to bound memory and delay.

The price is latency: stream text reaches the client about 256 characters late while a response policy is active. Streams without response policies are not buffered at all.

## Overhead

`guardrails.test.ts` measures a regex policy on a 4 KB prompt: about **0.003 ms** per check on the development machine, against a budget of 1 ms.

## Testing a policy before saving

`POST /orgs/:orgId/guardrails/test` with `{type, action, config, text}` returns whether the text would be blocked, the matches and the redacted text, without storing anything. The dashboard form has a **Live test** box that uses it; the preview and the gateway apply the same validation rules.

## Management API

`GET|POST /orgs/:orgId/guardrails`, `PATCH|DELETE /orgs/:orgId/guardrails/:id` (permissions `guardrails:read` / `guardrails:write`). Changes are published to the gateways as a new config version and written to the audit log.

[English](errors.md) · [فارسی](errors.fa.md)

# Upstream error classification

> Code: `packages/providers/src/errors.ts` (card 5.2). The behavior of each class is fixed in the code itself; config can only make fallback **more restrictive** (`combo.fallbackOn`), not looser.

| class            | from which response                                                      | retry on same target   | fallback to next target                   | effect on credential                                        |
| ---------------- | ------------------------------------------------------------------------ | ---------------------- | ----------------------------------------- | ----------------------------------------------------------- |
| `rate_limit`     | 429 (with `Retry-After`, `retry-after-ms` or `x-ratelimit-reset-*`)      | ✅ (after Retry-After) | ✅                                        | cooldown until Retry-After; `insufficient_quota` → disabled |
| `overloaded`     | 529, `overloaded_error`, 503 with an overload message                    | ✅                     | ✅                                        | —                                                           |
| `server`         | other 5xx                                                                | ✅                     | ✅                                        | —                                                           |
| `timeout`        | 408, connect/TTFT/idle timeout of the gateway                            | ✅                     | ✅                                        | —                                                           |
| `connection`     | network error (ECONNREFUSED, ECONNRESET, DNS, TLS)                       | ✅                     | ✅                                        | —                                                           |
| `auth`           | 401, 403                                                                 | ❌                     | ✅                                        | credential disabled                                         |
| `not_found`      | 404 (model or deployment not available)                                  | ❌                     | ✅                                        | —                                                           |
| `context_length` | 413, or 400 with "context length / prompt is too long / maximum context" | ❌                     | ✅ only to a target with a larger context | —                                                           |
| `content_filter` | 400 with "content policy / content filter / safety"                      | ❌                     | ❌                                        | —                                                           |
| `bad_request`    | other 4xx                                                                | ❌                     | ❌ **never**                              | —                                                           |

Notes:

- `bad_request` and `content_filter` are never sent to another provider. A bad request is bad everywhere, and sending it only creates cost and data leakage.
- A stream error (an `error` event in the middle of a stream) is classified with the same table; fallback is only possible before the first byte is sent to the client (card 5.7).
- The raw provider message is kept for logs (`upstreamType`). The client receives DiRouter's stable code (`upstream_error`, `upstream_timeout`, `upstream_overloaded`, `rate_limited`, `no_available_provider`).

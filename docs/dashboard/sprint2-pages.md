# Dashboard pages added in Sprint 2

> Code: `apps/dashboard/src/pages/{cost,analytics,live,simulator,playground,guardrails,alerts,security,config}.tsx`, shared pieces in `components/s2`, pure helpers in `lib/s2-helpers.ts`, messages in `i18n/s2`. All pages are Persian (RTL) and English, lazy-loaded, and use the global time range where a range applies.

| Page                  | Route         | Card        | What it shows                                                                                                                                                                                    | API                                                   |
| --------------------- | ------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Cost and budgets      | `/cost`       | 16.1, 13.2  | period cost next to the **ledger total** with a match indicator, cost per day, top models, budget bars for the current period, cache hit rate and savings, semantic cache, latest ledger entries | `GET stats/cost`, `GET stats/cache`, `cache/semantic` |
| Analytics             | `/analytics`  | 16.4        | KPIs, trend chart (requests, cost, errors, tokens), breakdowns by model, key, project and provider                                                                                               | `GET stats/analytics`                                 |
| Live view             | `/live`       | 16.3, 24.4  | requests of the last 15 minutes and open breakers; new requests pushed over SSE, polled every second while the stream is down, with pause                                                        | `GET stats/live`, `GET stats/live/stream`             |
| Routing simulator     | `/simulator`  | 12.5        | attempt order and the reason every skipped target was left out                                                                                                                                   | `POST routes/simulate`                                |
| Playground            | `/playground` | 16.5        | one prompt on up to four models: answer, latency, tokens, estimated cost                                                                                                                         | `POST playground/compare`                             |
| Guardrails            | `/guardrails` | 15.2        | policies, enable/disable, create with a live test                                                                                                                                                | `guardrails`, `POST guardrails/test`                  |
| Alerts                | `/alerts`     | 16.2        | channels (with test message), rules, events and acknowledgement                                                                                                                                  | `alerts/channels`, `alerts/rules`, `alerts/events`    |
| Security              | `/security`   | 14.1 – 14.5 | MFA-required roles, SSO-only switch, SSO connections, custom roles, audit log + CSV, key rotation                                                                                                | `security`, `sso`, `custom-roles`, `audit`            |
| Settings and versions | `/config`     | 17.1        | gateway-wide settings editor, version list with diff, rollback, export and import                                                                                                                | `config/settings`, `config/versions`, `config/*.yaml` |

All API paths are under `/orgs/:orgId/`.

## Drill-down (Analytics and Cost)

Every chart column and every breakdown row is a button that opens the **Request Log** with the same slice: a time bucket becomes `from`/`to`, a model row becomes `model`, a key row `apiKeyId`, a project row `projectId`, a provider row `providerId`; on the errors metric the log is also filtered to `status=error`.

## Cost reconciliation

The page shows the rollup total (fast aggregate tables) and the ledger total (one row per request, the financial source of truth) for the selected range. Rollups are recomputed every 30 seconds (`ROLLUP_INTERVAL_MS`), so the live totals differ under any traffic. The check therefore runs on a second `GET stats/cost` request whose `to` is the end of the last **closed** rollup bucket: the previous full hour for ranges up to 7 days (`usage_hourly`), the previous full UTC day for longer ranges (`usage_daily`), in both cases only once the bucket has been closed for two minutes. The API exposes no rollup watermark, so this boundary is derived in the browser (`settledWindow` in `lib/s2-helpers.ts`). Over that window the two totals must agree to within $0.0001; a difference there points to a problem in the usage pipeline. Whatever the ledger holds after the boundary is shown as **pending aggregation**, not as a mismatch.

Amounts below $0.00005 are not rounded to `$0.00`: they keep two significant digits (`$0.000012`), and anything below a millionth of a dollar reads `<$0.000001`, in both locales.

## Semantic cache

The Cost page also has a **Semantic cache** section (`GET cache/semantic`, `DELETE cache/semantic`): whether it is enabled, the embedding model, entry count and text size, a sample of cached prompts and a purge button. When the response has `available: false` the section only says that the pgvector extension is not installed. Prompt samples and the purge button are hidden when `sampleAllowed` is false (the caller lacks `models:write`).

## Live view and privacy

The live endpoint returns request **metadata only**: time, model, provider, status, error code, latency, tokens and cost. Prompt and response content is not stored in `request_log` and cannot appear here. With a one-second poll and the worker's 200 ms write batch, a finished request shows up in well under two seconds; the page prints the measured display delay of the newest row. Polling stops while the browser tab is hidden and resumes (with an immediate refresh) when it becomes visible.

The endpoint returns the latest 50 rows and no server-side counters, so "requests in the last minute" and "errors" are counted within those rows and labelled that way ("of the last 50 requests"); when all 50 rows are from the last minute the count is shown as `50+`.

## Playground and billing

The playground asks for a virtual key **that the signed-in user created** and sends the comparison through the gateway with it, so limits, budgets and guardrails apply and the usage is recorded against that key like any other request. The key is kept in page state only (never in storage) and control-api uses it for the outbound calls without storing or logging it. The cost shown is an estimate from the current price list; the ledger holds the charged amount.

## Account page

**Account** gained a two-factor card: enable TOTP, confirm with a code, see the recovery codes once, replace the authenticator (the current code is required and sent as `{ code }` to `POST auth/mfa/setup`) and disable with a code. The secret is shown as text and as an `otpauth://` link; there is no QR code because the dashboard has no QR dependency.

A **Passkeys** card lists the registered passkeys and lets the user add one (`POST auth/webauthn/options`, then `navigator.credentials.create` with user verification required, then `POST auth/webauthn/verify`) or remove one. It is hidden in browsers without WebAuthn.

## Sign-in, SSO and invitations

- The login page asks for the code when the account has MFA, offers **Sign in with company SSO** and, where WebAuthn is available, **Sign in with a passkey** (`auth/webauthn/login/options` and `login/verify`).
- SSO: the server derives the redirect URI (`<PUBLIC_DASHBOARD_URL>/login`) and binds `state` to the HttpOnly cookie `dr_sso_state`; all requests of the API client send credentials. The dashboard also keeps the `state` returned by the start call in `sessionStorage` and refuses to exchange a `?code=&state=` whose state does not match. After a successful exchange the returned `organizationId` becomes the active organization, and `code`/`state` are removed from the address bar.
- `/invite/<token>` accepts an invitation: a new account enters a name and a password; an existing account enters its own password and, when the server answers `mfa_required`, its verification code (sent as `mfaCode`), like the login page.
- A 401 on an authenticated `/auth/*` call (MFA, passkeys, password, `me`) with the code `unauthenticated` is answered with one refresh and one retry. The sign-in endpoints themselves (`login`, `refresh`, `logout`, `setup`, `sso/*`, `invitations/accept`, `webauthn/login/*`) are never retried.

## Permissions and read-only states

Write controls on the Security, Config and Guardrails pages use `can()` in `lib/session.ts`. It reads the effective permission list of the membership (`permissions` on each organization of `GET auth/me`) when the API sends it; today the API sends only the base role, so the check falls back to the base-role matrix and a member whose custom role adds a permission still sees those pages read-only.

- **Security**: SSO connections can be listed with `security:write` but created, changed or removed only by an OWNER; everyone else sees the form disabled with an explanation. A connection needs at least one allowed domain, and OWNER is not offered as an SSO role.
- **Config**: reads return only the caller organization's slice with secrets as `***`. The gateway-wide settings are editable by an OWNER only. Rollback and import can answer 403 for non-owners (more than one organization on the instance, or a settings change); the page explains that instead of a generic error. An exported YAML can be imported again unchanged: the `***` placeholders keep the stored secrets.
- **Guardrails**: creating, changing and testing a policy need `guardrails:write`; without it the list is read-only and the test panel is hidden. A regex the server refuses (nested quantifiers, backreferences, over 1000 characters) is reported next to the pattern field; the sample text is limited to 10 000 characters.
- **Alerts**: channel secrets come back as `***` with `secretFields` and `hasSecret`. The edit form leaves them blank ("stored — leave blank to keep") and omits them from the update unless a new value is typed; the mask is never posted. New rules can only use `error_rate`, `latency`, `budget` (threshold required) and `invalid_credential`.

## Live view over SSE (card 24.4)

> Code: `apps/gateway/src/live.ts`, `packages/contracts/src/live.ts`, `apps/control-api/src/stats/live.{hub,controller}.ts`, `apps/dashboard/src/lib/live-stream.ts`.

```
gateway ──PUBLISH dirouter:live:<org>──▶ Valkey ──SUBSCRIBE──▶ control-api ──SSE──▶ Live page
```

- When a request finishes, the gateway publishes one event on its organization's channel `dirouter:live:<organizationId>`: the same metadata as a request log row (id, time, model, provider, status, tokens, cost, latency), never a prompt, answer, end user or credential. Fire and forget: with Valkey down the event is dropped.
- control-api keeps one subscriber connection per process and subscribes to an organization's channel only while a page of that organization listens. Each event is validated against `LiveRequestEvent` before it is written, so only documented fields reach a browser.
- `GET /orgs/:orgId/stats/live/stream` (`usage:read`) answers `text/event-stream`: `retry: 3000`, `event: ready` once the subscription is confirmed, then one `event: request` per finished request, and a `: keep-alive` comment every 15 seconds. At most 500 streams per control-api process (503 beyond that) and 5 per user per process (429); in both cases the page polls. Every 30 seconds an open stream re-checks its caller: the session is still signed in (or the management token still valid), the user is still active and a member whose role grants `usage:read`; otherwise it sends `event: revoked` and closes, and the page's polling goes through the guards again.
- The page reads the stream with `fetch` (EventSource cannot send the bearer token). While the stream is up it still polls `stats/live` every 15 seconds for breaker state and anything missed; when the stream fails, ends or cannot be opened it shows "refreshing every second", polls every second and reconnects after 1, 2, 5, 10 and then 30 seconds. Pausing closes the stream.
- A new request appears as soon as the gateway finishes it: the integration test measures the publish-to-browser time (well under two seconds; the requirement is two).

## After changing the API

The pages call the API through `lib/api` directly, so they do not depend on the generated client. Regenerate the OpenAPI document and `src/api/generated.ts` anyway after pulling these changes, so the generated client and the `openapi` test match the new endpoints.

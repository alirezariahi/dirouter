# Upstream balances and scheduled channel tests (card 32.9)

Know that a provider account is running out of credit before requests start failing, and notice
a key that lost its credit or access even when the model list still answers.

## Upstream balance

For providers with a balance API, the gateway reads the credit left on each enabled credential.

| Kind          | Request                       | Value                                       | Currency          |
| ------------- | ----------------------------- | ------------------------------------------- | ----------------- |
| `openrouter`  | `GET {base}/credits`          | `data.total_credits − data.total_usage`     | USD               |
| `deepseek`    | `GET {origin}/user/balance`   | `balance_infos[].total_balance` (USD first) | USD or CNY        |
| `moonshot`    | `GET {base}/users/me/balance` | `data.available_balance`                    | USD; CNY on `.cn` |
| `siliconflow` | `GET {base}/user/info`        | `data.totalBalance`                         | CNY               |

- A provider uses one when its preset is one of these (`options.preset`, set by the Add provider
  wizard), or when `options.balance` names one (for a custom base URL). `"balance": "none"` turns
  it off. OpenAI, Anthropic and most others have no balance API for API keys.
- **Schedule**: `settings.upstreamBalance` (`enabled`, default `true`; `intervalSeconds`, default
  `3600`, at least 300). One replica per round (Valkey lock `dirouter:balances:lock`); samples go
  to the `dirouter:balances:samples` list and the worker's `balances` job (every 30 seconds) keeps
  the newest one per credential in `credential_balances`.
- The lookup uses the credential's token, proxy and the production SSRF guard, like traffic.
- **Providers page**: each credential shows its balance and when it was checked; _Refresh
  balance_ (`POST /orgs/{org}/providers/{id}/balance`, permission `providers:write`) looks it up
  now. A failed lookup keeps the last known amount and shows the error.

### Low balance alert

Alert rule type `upstream_balance_low` (see [alerts.md](alerts.md)): the value is the lowest
balance among the organization's active credentials looked up in the last 7 days, and the rule
fires when it is **at or below** the threshold (in the provider's currency). The event details list
the balances, lowest first. A threshold is required; with no balance known the rule is skipped.

## Scheduled channel tests

A separate schedule from the model-list health probe ([concepts/routing.md](concepts/routing.md)):
one small real request per credential, a one-token completion on the provider's cheapest enabled
chat model.

| Setting (`settings.channelTest`) | Default | Description                                           |
| -------------------------------- | ------- | ----------------------------------------------------- |
| `enabled`                        | `false` | off by default                                        |
| `intervalSeconds`                | `3600`  | time between rounds (minimum 60)                      |
| `failureThreshold`               | `2`     | consecutive failures before a credential is disabled  |
| `successThreshold`               | `1`     | consecutive passes before it is restored              |
| `maxPerRound`                    | `20`    | cap of credentials tested per round (rotating window) |

- **Disabled for**: authentication errors (401/403) and exhausted credit (`quota`: HTTP 402, or
  `insufficient_quota`/billing errors). Outages (5xx, timeouts) are the breaker's job.
- **Restored automatically** once the credential passes again; the change reaches every replica.
  The model-list probe never restores a credential a channel test disabled, since a model list
  answers even without credit.
- Disable reasons start with `channel_test:` on the Health page. Results are stored as health
  samples (uptime history; `invalid_credential` alerts count the `auth` ones).
- A test spends a few tokens on the operator's account and is not a customer request: it writes
  no usage event. One replica per round (lock `dirouter:health:channel-test-lock`).

## Testing without real accounts

The mock provider answers all four balance APIs (`PUT /__mock/balance {"amount": 0.5}` sets the
value) — see [mock-provider.md](mock-provider.md).

---
'@dirouter/contracts': minor
'@dirouter/providers': minor
'@dirouter/db': minor
'@dirouter/gateway': minor
'@dirouter/worker': minor
'@dirouter/control-api': minor
'@dirouter/dashboard': minor
'@dirouter/mock-provider': minor
---

Upstream balances and scheduled channel tests: the gateway periodically reads the credit left on OpenRouter, DeepSeek, Moonshot and SiliconFlow accounts (preset or `options.balance`), the worker keeps the latest balance per credential, and the Providers page shows it with a refresh button. The new `upstream_balance_low` alert rule fires when a balance falls to its threshold and is delivered to the rule's channel. A separate scheduled channel test (`settings.channelTest`) sends a one-token request per credential, takes keys with auth or credit failures out of rotation and restores them once they pass again (card 32.9).

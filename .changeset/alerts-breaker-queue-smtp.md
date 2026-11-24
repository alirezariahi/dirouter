---
'@dirouter/worker': minor
'@dirouter/gateway': minor
'@dirouter/control-api': minor
'@dirouter/contracts': minor
'@dirouter/shared': minor
'@dirouter/dashboard': minor
---

Alerts: `breaker_open` and `queue_length` rules work. The gateway writes breaker transitions to
the Valkey hash `dirouter:breakers` and the worker counts the organization's open breakers;
`queue_length` reads the size of the BullMQ usage queue and needs a threshold. Email channels send
over SMTP with TLS (`SMTP_URL`, `SMTP_FROM`, now also read by the worker); a channel with a
`webhookUrl` keeps using its HTTP relay. The control-api sends invitation emails and channel test
messages through the same mailer, and the invitation response says whether the email went out
(`emailSent`). The worker joins the `edge` network in Compose so it can reach SMTP servers and
webhooks outside the host.

---
'@dirouter/gateway': minor
'@dirouter/control-api': minor
'@dirouter/worker': minor
'@dirouter/contracts': minor
'@dirouter/db': minor
'@dirouter/dashboard': minor
---

Request bodies: the gateway can now keep a request's body and answer per organization, project or
virtual key (`none`, `metadata` or `full`; off by default). Bodies are masked by the `redact`
guardrail policies and by the credential patterns before they leave the gateway, cut at
`settings.bodyCapture.maxBytes`, sent over their own `request-bodies` queue (never with usage
events) and kept in the daily-partitioned `request_bodies` table for `REQUEST_BODY_RETENTION_DAYS`
(default 7), independent of the request log. The Log Explorer shows the payload to members with
the new `logs:bodies` permission (OWNER and ADMIN), and **Replay in playground** runs the stored
conversation again with any model. The previously unused `settings.logBodies` now means `full` as
the instance default. Migration `20261124213000_request_bodies`.

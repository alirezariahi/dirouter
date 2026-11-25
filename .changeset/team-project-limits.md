---
'@dirouter/control-api': minor
'@dirouter/dashboard': minor
---

Team and project limits can now be set: `GET/PUT/DELETE /orgs/:orgId/limits/:scope/:scopeId`
writes RPM, TPM, concurrency and daily or monthly budgets with alert thresholds for a team or
project, and `GET /orgs/:orgId/limits/usage` reports what each team and project spent today and
this month. Budget changes go through change requests when four-eyes approval is on. The
Organization page edits the limits and the Cost page shows the current usage.

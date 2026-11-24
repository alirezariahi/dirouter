---
'@dirouter/control-api': minor
'@dirouter/dashboard': minor
'@dirouter/db': minor
---

Management API tokens and service accounts: automation (CI, scripts, Terraform) can now call the
management API without a user signing in. A service account is a non-human member of one
organization with a role (`ADMIN`, `MEMBER` or `VIEWER`) and optional custom role; it can never
sign in. Its tokens (`drm_…`, only the SHA-256 is stored, shown once) are scoped to permissions of
the RBAC matrix, expire after 1 to 730 days or never, and can be limited to IP addresses or CIDR
ranges. A request is allowed only when both the token's scopes and the account's current role grant
the route's permission, so a read-only token cannot change anything; a revoked or expired token is
refused on its next request. Managing service accounts and deciding change requests stay closed to
tokens. Every use is audited as `management_token.used`. New tables `service_accounts` and
`management_tokens` and the column `users.is_service_account` (migration
`20261124230000_management_tokens`). The security page in the dashboard manages both.

---
'@dirouter/control-api': minor
'@dirouter/portal': minor
'@dirouter/db': minor
'@dirouter/contracts': minor
'@dirouter/dashboard': patch
---

Portal sign-up verifies the email address. A password sign-up gets a one-time link by email
(24 hours, only its hash is stored); until it is opened the account cannot create API keys
(`403 email_not_verified`) and gets no welcome credit. `POST /portal/verify-email` opens the link,
`POST /portal/verify-email/resend` sends a new one (rate limited per user); used and expired links
are refused with `verification_link_invalid`. An OIDC sign-in with `email_verified: true` needs no
link. Without `SMTP_URL`, password sign-up is refused and `GET /portal/config` says
`passwordSignup: false`. Migration `email_verification` adds `users.email_verified_at` (existing
accounts count as verified) and the `email_verifications` table; `GET /auth/me` returns
`emailVerified`.

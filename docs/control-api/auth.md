[English](auth.md) · [فارسی](auth.fa.md)

# Dashboard authentication, sessions, management tokens and setup wizard

Code: `apps/control-api/src/auth` · tests: `auth.unit.test.ts` and `auth.integration.test.ts` · card 3.4

## Endpoints (`/api/v1/auth`)

| route                       | description                                                                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /setup`                | `{"required": true}` as long as there are no users                                                                                                                                         |
| `POST /setup`               | `{organizationName, name, email, password}`: creates the organization, the user and the OWNER membership, and signs in. After the first user, it always returns **409 `setup_completed`**. |
| `POST /login`               | `{email, password}`: the response is an access token, and the refresh token is set in a cookie                                                                                             |
| `POST /refresh`             | with the cookie: rotates the token and returns a fresh access token                                                                                                                        |
| `POST /logout`              | revokes the session family and clears the cookie (204)                                                                                                                                     |
| `POST /password`            | with Bearer: `{currentPassword, newPassword}`; all of the user's refresh tokens are revoked (204)                                                                                          |
| `GET /me`                   | with Bearer: the user (with `emailVerified`) and their organizations with roles                                                                                                            |
| `GET /sessions`             | with Bearer: the user's active sessions (see [Sessions](#sessions))                                                                                                                        |
| `DELETE /sessions/{id}`     | with Bearer: ends one of the user's sessions (204; 404 when it is not theirs or already over)                                                                                              |
| `POST /sessions/revoke-all` | with Bearer: `{includeCurrent?: false}`; signs out every other session, or every session including this one                                                                                |

All of these are in Swagger (`/api/docs`) with the full schema from zod. Errors are returned in `application/problem+json` format with stable codes.

## Password

- **argon2id** (`@node-rs/argon2`, a prebuilt binary for linux-musl/arm64/x64) with OWASP parameters: m=19MiB, t=2 and p=1.
- The password is at least 10 and at most 256 characters. The maximum prevents DoS against argon2.
- Email is stored and compared in lowercase.
- For a non-existent email, a verify is also run against a fixed hash, and the response is the same `invalid_credentials`. So neither the response time nor the message reveals whether an account exists.

## Tokens

|          | access token                                                                      | refresh token                                                                     |
| -------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| format   | JWT HS256 (`jose`) with `JWT_SECRET`, iss `dirouter` and aud `dirouter-dashboard` | 32 random bytes (base64url)                                                       |
| lifetime | 15 minutes                                                                        | 30 days                                                                           |
| where    | response body; the dashboard keeps it in memory, not in localStorage              | cookie `dr_refresh`: `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/api/v1/auth` |
| in DB    | —                                                                                 | only `HMAC-SHA256(JWT_SECRET, token)` in `refresh_tokens.token_hash`              |

### Rotation and theft detection

Each login creates a **family** (`family_id`). Each `refresh`:

1. Finds the token. If it has `used_at` or `revoked_at`, the token was already used (someone has a copy of it). **The whole family is revoked**, and the response is 401 `refresh_token_reused`. So both the attacker and the real user are logged out, and the user has to sign in again.
2. `UPDATE … SET used_at = now() WHERE id = ? AND used_at IS NULL`. The condition is inside the UPDATE, so of two simultaneous refreshes with one token, only one wins and the other is treated as reuse.
3. A new token is issued in the same family.

Changing the password revokes all refresh tokens of the user.

Every access token carries its session (the refresh-token family) in the `sid` claim. AccessGuard
refuses an access token whose session has no unrevoked refresh token left, so logout, a password
change, a reused refresh token or a revoked session also end the access tokens of that session on
their next request (401 `unauthenticated`), instead of leaving them valid for up to 15 minutes. The
check is one indexed lookup on `refresh_tokens.family_id`. Tokens issued before this change have no
`sid` and simply expire.

## Sessions

Card 23.5 · tests: `sessions.integration.test.ts`, `sessions.unit.test.ts` and the dashboard's
`sessions-card.test.tsx`.

A session is one refresh-token family: it starts at sign-in (password, passkey, SSO, setup or an
accepted invitation) and keeps its id through every rotation.

| field          | meaning                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| `id`           | the family id; pass it to `DELETE /auth/sessions/{id}`                                                  |
| `device`       | a label parsed from the user agent, such as `Firefox on Linux`; the raw `userAgent` is returned as well |
| `ip`           | the address of the latest sign-in or refresh                                                            |
| `createdAt`    | when the user signed in                                                                                 |
| `lastActiveAt` | the latest refresh; the dashboard refreshes while it is open, so this is the session's last activity    |
| `method`       | `pwd`, `passkey` or `sso`                                                                               |
| `current`      | true for the session that made the request                                                              |

- Ending a session revokes every refresh token of the family at once: the next `POST /auth/refresh`
  with its cookie gets 401, and its access tokens get 401 on their next request.
- `POST /auth/sessions/revoke-all` keeps the calling session unless `includeCurrent: true`; then the
  cookie is cleared as well.
- Administrators: `GET /orgs/{orgId}/members/{userId}/sessions` and
  `POST /orgs/{orgId}/members/{userId}/sessions/revoke` (permission `members:write`) list and end all
  sessions of a member. The rule for role changes applies: nobody can sign out a member with more
  access than their own (an ADMIN cannot sign out an OWNER).
- Sessions are **per person, not per organization**: one sign-in opens every organization the
  member belongs to. An organization administrator therefore sees only what concerns them: how many
  sessions there are, with `id`, `method`, `createdAt`, `lastActiveAt` and `expiresAt`. The address
  and device are withheld (`ip` and `userAgent` are `null`, `device` is `Hidden`), because they
  would show the member's activity in their other organizations. Revoking still ends the member's
  sessions everywhere, since there is nothing narrower to end; removing the member is the
  organization-scoped way to cut access. Both routes are `@HumanOnly()`: a management token cannot
  use them whatever its scopes.
- Audit log: `session.revoked` and `session.revoked_all` (with the number of sessions) are recorded
  in every organization of the user; an administrator's action is recorded as
  `member.sessions_revoked` in the organization where it was taken, with the administrator as actor.
- Dashboard: the account page lists the sessions with "Sign out this device", "Sign out all other
  devices" and "Sign out everywhere"; the organization page has a "Sign out everywhere" button per
  member for those who can manage members.

## Management API tokens and service accounts

Card 23.6 · code: `apps/control-api/src/service-accounts` and `src/auth/management-token.ts` ·
tests: `service-accounts.integration.test.ts`, `management-token.unit.test.ts` and the dashboard's
`service-accounts.test.tsx`.

Automation (CI, scripts, Terraform) calls the management API with a **management token** instead of
a user session:

```bash
curl -H "Authorization: Bearer drm_…" https://admin.example.com/api/v1/orgs/<orgId>/keys
```

### Service accounts

A service account is a non-human member of one organization. It is backed by a user row with
`is_service_account = true` and no password, so it can never sign in (password, passkey, SSO or an
invitation), and a membership that carries its role (`ADMIN`, `MEMBER` or `VIEWER`, never `OWNER`)
and an optional custom role. Changes it makes are audited with it as the actor, and resources it
creates (keys, projects) name it as their creator. It does not appear in the member list and cannot
be changed through the member routes.

| route (`/api/v1/orgs/{orgId}`)       | permission       | description                                                                                               |
| ------------------------------------ | ---------------- | --------------------------------------------------------------------------------------------------------- |
| `GET /service-accounts`              | `members:read`   | accounts with their role, effective `permissions` and tokens (never the token itself)                     |
| `POST /service-accounts`             | `security:write` | `{name, description?, role, customRoleId?}`                                                               |
| `PATCH /service-accounts/{id}`       | `security:write` | name, description, role or custom role                                                                    |
| `DELETE /service-accounts/{id}`      | `security:write` | removes the membership, revokes every token and disables the backing user                                 |
| `POST /service-accounts/{id}/tokens` | `security:write` | `{name, scopes, expiresInDays?, allowedIps?}`; the response holds `token`, **shown only this once** (201) |
| `DELETE /management-tokens/{id}`     | `security:write` | revokes the token (204)                                                                                   |

Nobody can give a service account a role above their own or a custom role with permissions they
lack, or manage an account that has more access than they do (the rule for members, card 14.3).

### Tokens

| property   | value                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| format     | `drm_` and 32 random bytes in base64url (47 characters); virtual keys start with `dr-` and SCIM tokens with `scim_`      |
| in DB      | only the SHA-256 of the token in `management_tokens.token_hash`, and the first 12 characters for display                 |
| scopes     | permissions of the RBAC matrix ([docs/rbac.md](../rbac.md)); a read-only token has only `*:read` scopes                  |
| expiry     | `expiresInDays` from 1 to 730, default 90; `null` never expires                                                          |
| allow-list | optional `allowedIps`: addresses or CIDR ranges, IPv4 and IPv6 (`10.0.0.0/8`, `2001:db8::/32`); empty allows any address |

At issue time every scope must be granted by the service account's role (otherwise 422) and held by
the person issuing it (otherwise 403).

### How a request with a token is checked

AccessGuard recognises the `drm_` prefix and looks the token up on **every request**:

1. Unknown, revoked or expired token, or a deleted service account: **401** `unauthenticated`. A
   revoked token is therefore refused on its very next request; nothing is cached.
2. Address not in `allowedIps`: **403**. The address is the client address as the trusted proxy
   reports it in `X-Forwarded-For`. Which proxies are trusted is set with `TRUST_PROXY`
   ([env reference](../env-reference.md)); the default, one hop, is the bundled Traefik. Behind
   another proxy in front of Traefik (a cloud load balancer that adds the header), set the number
   of hops or the proxies' addresses; never `true` behind a proxy that appends to the header, since
   the client could then choose the address the allow-list sees.
3. Routes outside `/orgs/{orgId}` (account, sessions, MFA, passkeys): **403**. Another
   organization's routes: **404**, as for a non-member.
4. OrgGuard: the permission of the route must be granted by **both** the token's scopes and the
   service account's current role, so demoting the account narrows its tokens at once.
   Organization MFA policies do not apply to tokens.
5. Some routes are never open to tokens, whatever their scopes (`@HumanOnly()`): managing service
   accounts and tokens, approving or rejecting change requests (a second person must decide,
   card 22.2), and listing or ending a member's sessions.

A change request made with a token is recorded with the service account as `requestedById` and the
person who created the token as `requestedByHumanId`. Neither that person nor the person who created
the service account can approve it: a token does not let its owner be their own second pair of eyes.

Actions that need a verified email address (creating API keys, sending a test email to an alert
channel) check the person who created the token when they are made with a token; the service
account's own user does not count. Creating a service account needs a verified address as well.

A unit test walks every organization route and fails if one that changes something (POST, PATCH,
PUT, DELETE) needs only a `:read` permission without being closed to tokens; the two exceptions
(playground compare and the routing simulator) compute an answer without storing anything.

### Audit log

- `service_account.created`, `.updated`, `.deleted`, `management_token.created` (with scopes,
  expiry and allow-list) and `management_token.revoked`, with the person as actor.
- `management_token.used` with the service account as actor, the address and `{method, route}`:
  every change made with a token, and reads at least once an hour per token and on every new
  address. The token's `last_used_at` and `last_used_ip` are kept current (to the minute).
- The change itself is audited by its route as usual (for example `key.created`), with the service
  account as actor.

### Dashboard

The security page lists service accounts and their tokens (prefix, read-only or number of scopes,
allow-list, expiry, last use and address). With `security:write`: create and delete accounts, issue a
token with a preset (read-only, everything the role allows, or chosen permissions), an expiry and an
optional allow-list, see the token once, and revoke tokens.

## Login attempt limit

| level                     | limit        | window and lock                                                                              |
| ------------------------- | ------------ | -------------------------------------------------------------------------------------------- |
| each account (email hash) | 10 failures  | 15 minutes from the first failure; until the window ends, even the correct password gets 429 |
| each IP                   | 100 failures | 15 minutes; prevents password spraying across different accounts                             |

- Lock response: **429 `login_locked`** with a `Retry-After` header in seconds.
- A successful login resets the account counter.
- The counters are in Valkey (`dirouter:login:*`), so they are shared between replicas. If Valkey is unavailable, the in-memory counter of the same node is used: login does not fail, and each node's protection continues separately.
- Manually unlocking:

  ```bash
  valkey-cli --scan --pattern 'dirouter:login:acct:*' | xargs valkey-cli del
  ```

## Setup wizard

- In one transaction with `pg_advisory_xact_lock`: count the users, create the organization (slug from the name; for a Persian name, `org-xxxxxxxx`), the user and the OWNER membership, and record `setup.completed` in the audit log.
- Two simultaneous requests: exactly one gets 201 and the other gets 409 (integration test).

## Portal sign-up and email verification (card 23.4)

Code: `apps/control-api/src/portal` · tests: `portal.integration.test.ts` (against a real SMTP listener)

A password sign-up in the self-service portal (`POST /api/v1/portal/signup`) creates the user, a prepaid workspace and its default project, and signs the user in, but the address is **not verified** yet:

- `GET /auth/me` returns `emailVerified: false`;
- creating an API key in any organization is refused with **403 `email_not_verified`**;
- the welcome credit (`portal.welcomeCreditUsd`) is not granted.

The sign-up emails a one-time link, `<PUBLIC_PORTAL_URL>/verify-email?token=…`, over SMTP (`SMTP_URL`, see [alerts](../alerts.md#channels)). The token is 32 random bytes; only its SHA-256 is stored, in `email_verifications`, with a 24-hour expiry. The response says `emailVerified: false` and whether the email went out (`verificationEmailSent`).

| route                              | description                                                                                                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /portal/verify-email`        | `{token}`, no session needed: marks the address verified and grants the welcome credit once (idempotency key `welcome:<org>`). The link is claimed with a conditional update, so it works exactly once. |
| `POST /portal/verify-email/resend` | with Bearer: a new link; older unused links stop working. One per minute and three per hour per user (**429** beyond that); **409** when the address is already verified.                               |

An unknown, used or expired link is refused with **400 `verification_link_invalid`**, and the `detail` says which. Without `SMTP_URL` the link could never arrive, so password sign-up is refused (403) and `GET /portal/config` reports `passwordSignup: false`; OIDC sign-up still works.

**OIDC**: the portal's OIDC sign-in only accepts an ID token with `email_verified: true`, so an account it creates is verified at once (credit and keys immediately, no email). If a password sign-up that never opened its link later signs in through OIDC with the same verified address, the account becomes verified then.

**Invitations**: the inviter always gets the invitation link back (`url` and `token` in the response), so accepting it proves the invitee's address only when the link was also delivered to that address by email (`emailSent: true`, recorded as `invitations.email_sent_at`). A new account created from an invitation that was not delivered starts unverified, like a portal sign-up, and verifies with `POST /portal/verify-email/resend`. Without `SMTP_URL` no address can be verified at all; then an invitation from a verified inviter still gives a verified account, as before. Accepting with an existing account does not change its verification.

Besides API keys, an unverified person cannot create service accounts (**403 `email_not_verified`**; a service account's user counts as verified, so it would otherwise get around the check) or send a test notification to an email alert channel.

Every other way an account is created (setup wizard, SSO, SCIM, seed) counts as verified: the column defaults to the creation time, and the migration marks existing accounts verified. The portal shows a notice with a **Send the link again** button until the address is verified.

## Check in compose (2026-11-07, through Traefik at `https://admin.localhost`)

| step                                          | result                                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `GET /setup` on an empty DB                   | `{"required":true}`                                                                           |
| `POST /setup`                                 | 201, and a cookie with `Path=/api/v1/auth`, `Secure` and `HttpOnly`                           |
| second `POST /setup`                          | 409 `setup_completed`                                                                         |
| `GET /me`                                     | the user and the organization "DiRouter Dev" with the OWNER role                              |
| `POST /refresh`, then resending the old token | 200, then 401 `refresh_token_reused`. The user's fresh token also got 401 after that.         |
| 10 wrong passwords                            | the tenth gets 429 `login_locked` with `Retry-After: 900`; the correct password also gets 429 |
| deleting the lock key in Valkey               | login 200                                                                                     |

The dev test user's password is in `.data/dev-owner.env` (git-ignored).

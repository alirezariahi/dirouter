# Single sign-on with OIDC (card 14.2)

> Code: `apps/control-api/src/security/sso.{service,controller}.ts`, dashboard login page and the Security page.

DiRouter signs users in through any OpenID Connect provider (Keycloak, Entra ID, Okta, Google Workspace, …) with the authorization-code flow.

## How the flow works

1. On the login page the user enters their work email and chooses **Sign in with company SSO**. The dashboard calls `POST /auth/sso/lookup`; a connection matches when its `allowedDomains` contains the email's domain.
2. `POST /auth/sso/:connectionId/start` returns the provider's authorization URL. The request uses **PKCE (S256)**, a random `state` and a `nonce`; all three are stored in Valkey for a few minutes and are single-use. The `state` is also bound to the browser through an HttpOnly cookie (`dr_sso_state`), so a callback only succeeds in the browser that started the flow. The redirect URI is always `<PUBLIC_DASHBOARD_URL>/login`; a `redirectUri` sent by the client is only checked against it.
3. The provider redirects back to `<dashboard>/login?code=…&state=…`. The dashboard removes the code from the address bar and calls `GET /auth/sso/callback`.
4. control-api exchanges the code, verifies the ID token signature against the provider's JWKS, and checks issuer, audience and nonce. `email_verified` must be `true` and the email's domain must be in `allowedDomains`.
5. A new user is provisioned just in time and added to the organization. An **existing** account is only accepted when it already is a member of the connection's organization; otherwise the login is refused and the user must be invited first (an identity provider only speaks for its own organization).
6. The user receives a session (access token + refresh cookie) that is valid **only for that organization**. From an SSO session the user cannot enroll passkeys or TOTP; that needs a session opened with their own password or passkey.

## Configuring a connection

Dashboard → **Security** → _SSO connections_, or the API (permission `security:write`):

```bash
curl -X POST "$ADMIN/orgs/$ORG/sso" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "name": "Company Keycloak",
  "issuer": "https://sso.example.com/realms/company",
  "clientId": "dirouter-dashboard",
  "clientSecret": "…",
  "defaultRole": "MEMBER",
  "allowedDomains": ["example.com"],
  "groupRoleMap": { "dirouter-admins": "ADMIN", "dirouter-members": "MEMBER" }
}'
```

| Field            | Meaning                                                                                                                                                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `issuer`         | OIDC issuer; `/.well-known/openid-configuration` is discovered from it. Must be `https` (plain `http` only when `NODE_ENV` is not `production`); in production the issuer, token and JWKS hosts must resolve to public addresses |
| `clientSecret`   | write-only; stored encrypted with `MASTER_KEY` and never returned                                                                                                                                                                |
| `allowedDomains` | **required**: the email domains this connection serves; other domains are refused                                                                                                                                                |
| `defaultRole`    | role for **new** users whose groups match nothing in `groupRoleMap`; never applied to existing members                                                                                                                           |
| `groupRoleMap`   | maps values of the token's `groups` claim to DiRouter roles; the highest matching role wins. A match can raise an existing member's role, never lower it                                                                         |

`OWNER` can never be assigned through SSO (neither as `defaultRole` nor in `groupRoleMap`), and nobody can configure a role above their own. Ownership is granted on the Members page by an existing owner.

At the provider, register `<PUBLIC_DASHBOARD_URL>/login` as the redirect URI, enable the authorization-code flow with PKCE, and expose a `groups` claim (the request asks for scopes `openid email profile groups`).

## SSO-only organizations

`PATCH /orgs/:orgId/security` with `{"passwordLoginDisabled": true}` disables password sign-in for the organization's members (login answers `sso_required`). It can only be turned on while at least one connection is enabled, so an organization cannot lock itself out. In SSO-only organizations the second factor is the identity provider's responsibility; the local mandatory-MFA policy does not apply while an enabled connection exists (see [security.md](security.md)).

## Testing locally with Keycloak

`compose.sso.yaml` adds a development Keycloak with a ready-made realm:

```bash
docker compose -f compose.yaml -f compose.dev.yaml -f compose.sso.yaml up -d --wait
```

| Item          | Value                                                                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Issuer        | `http://sso.localhost/realms/dirouter`                                                                                                  |
| Client ID     | `dirouter-dashboard`                                                                                                                    |
| Client secret | `dirouter-dev-client-secret`                                                                                                            |
| Test users    | `alice@example.com` / `alice-dev-password` (group `dirouter-admins`), `bob@example.com` / `bob-dev-password` (group `dirouter-members`) |
| Admin console | `http://sso.localhost/admin` (`admin` / `admin`)                                                                                        |

Create a connection with these values, then sign in as Alice from the dashboard login page:

```bash
curl -X POST "$ADMIN/orgs/$ORG/sso" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "name": "Local Keycloak",
  "issuer": "http://sso.localhost/realms/dirouter",
  "clientId": "dirouter-dashboard",
  "clientSecret": "dirouter-dev-client-secret",
  "defaultRole": "MEMBER",
  "allowedDomains": ["example.com"],
  "groupRoleMap": { "dirouter-admins": "ADMIN", "dirouter-members": "MEMBER" }
}'
```

- `allowedDomains` is required and must contain the domain of the test users (`example.com`); a connection without it is rejected.
- The `http://` issuer is accepted only because the development stack runs with `NODE_ENV` other than `production`. The same URL works from the browser and from the control-api container (Traefik answers for `sso.localhost` on the Docker network).
- Alice and Bob do not exist in DiRouter yet, so the first sign-in creates them in the organization that owns the connection. An email that already has a DiRouter account must already be a member of that organization; otherwise the sign-in is refused. Use the two test users, not the address of your seeded admin.

The realm file defines its client scopes in full (`basic`, `profile`, `email`, `groups`) and assigns all four to the client, because a realm import that lists any client scope does not get Keycloak's built-in ones. The ID token therefore carries `email`, `email_verified: true`, `preferred_username` and `groups`. To check it, decode the ID token of a sign-in, or use _Clients → dirouter-dashboard → Client scopes → Evaluate_ in the admin console.

These values are public test credentials; never use this realm outside local development.

> This overlay and realm file were validated with `docker compose config` and as JSON, but Keycloak has not been started with them yet. If the import fails on your Keycloak version, create the client and the mappers for `email`, `email_verified`, `preferred_username` and `groups` by hand in the admin console with the values above.

## SAML 2.0 (card 22.1)

Choose **SAML 2.0** as the protocol when adding a connection:

| Field                     | Value                                                                          |
| ------------------------- | ------------------------------------------------------------------------------ |
| IdP entity ID (`issuer`)  | the identity provider's entity ID, e.g. `http://sso.localhost/realms/dirouter` |
| SP entity ID (`clientId`) | DiRouter's entity ID as registered at the IdP, e.g. `dirouter-saml`            |
| `samlSsoUrl`              | the IdP single sign-on URL (HTTP-Redirect binding)                             |
| `samlCert`                | the IdP signing certificate (PEM or base64)                                    |

The connection shows its **ACS URL** (`/api/v1/auth/sso/saml/<id>/acs`) and a **metadata URL** to give the IdP. Rules:

- The assertion must be signed with the configured certificate and name our entity ID as audience.
- `InResponseTo` must match a request this server started (kept ten minutes in Valkey, consumed once), and a replayed assertion is refused.
- The email comes from the `email` attribute (or an email-format NameID); groups from the `groups` attribute. Group names map to roles exactly as with OIDC.
- The IdP posts cross-site to the ACS, so the browser's state cookie is not sent there. The ACS validates the assertion, parks the identity under a one-time code for two minutes, and sends the browser back to the dashboard. The dashboard finishes the sign-in through `/auth/sso/callback`, where the cookie is checked.

The local Keycloak realm has a SAML client `dirouter-saml`. `scripts/e2e/sprint-3.mjs 22.1` signs in alice with it.

## SCIM 2.0 provisioning (card 22.1)

An owner creates a SCIM token on the security page (`POST /orgs/:orgId/scim/tokens`; the token is shown once). The identity provider calls `/api/v1/scim/v2` with `Authorization: Bearer <token>`:

- Endpoints: `Users` and `Groups` (GET with `filter=attr eq "value"`, POST, PUT, PATCH, DELETE), `ServiceProviderConfig` and `ResourceTypes`.
- A user's role follows their groups through the organization's SSO connection group map (its default role when no group matches). OWNER is never assigned, and owners are never changed or deactivated through SCIM.
- `active: false` or DELETE removes the membership and revokes the API keys the user created in the organization. If the account has no other organization, it is disabled and its sessions are revoked. The gateway refuses the keys after the next snapshot. `active: true` restores the membership.
- An email that belongs to an account outside the organization is refused with 409, as with SSO.

Keycloak 26 has no built-in SCIM client. Keycloak, Okta or Entra ID can provision through a SCIM extension or their SCIM app settings.

## Troubleshooting

| Symptom                                            | Likely cause                                                                                                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "No active SSO connection for this email"          | the email's domain is not in `allowedDomains`, or the connection is disabled                                                                                  |
| `invalid SSO state`                                | the login took too long, the link was opened twice, or Valkey was restarted in between                                                                        |
| `SSO nonce mismatch` / signature errors            | the issuer URL differs between browser and control-api, or the clock is skewed                                                                                |
| Login works but the role is wrong                  | the token has no `groups` claim, or the group names differ from the keys of `groupRoleMap`                                                                    |
| Email not verified                                 | the provider must send `email_verified: true`                                                                                                                 |
| "SSO sign-in was not started in this browser"      | the `dr_sso_state` cookie is missing: the flow was started in another browser or tab profile, cookies are blocked, or the dashboard and API are not same-site |
| "…exists but is not a member of this organization" | the email already has a DiRouter account outside this organization; invite it first                                                                           |
| `redirectUri does not match…`                      | `PUBLIC_DASHBOARD_URL` differs from the address the dashboard is actually served on                                                                           |
| "SSO URL must resolve to a public address"         | in production the issuer (or its token/JWKS endpoint) points at a private or loopback address                                                                 |

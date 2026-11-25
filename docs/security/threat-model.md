# Threat model

Scope: a DiRouter deployment as in `compose.yaml` — Traefik, gateway, control-api, worker,
dashboard, portal, Postgres and Valkey — run by an operator (the platform organization) that may
sell access to customer organizations. Method: STRIDE per trust boundary. Last reviewed for
v1.0 (sprint 3).

## Assets

| Asset                      | Where                                                                      | Why it matters                             |
| -------------------------- | -------------------------------------------------------------------------- | ------------------------------------------ |
| Provider credentials       | Postgres, encrypted with `MASTER_KEY` (AES-256-GCM, versioned keys)        | Spending at the provider, data access      |
| Virtual keys               | Postgres and snapshot as peppered hashes (`KEY_PEPPER`); shown once        | Spend the organization's budget and wallet |
| Prompts and responses      | In flight; request bodies are not stored unless logging is enabled         | Customer data                              |
| Wallet balances and ledger | Postgres (append-only, zero-sum triggers) and Valkey holds                 | Money                                      |
| Sessions                   | Short JWT access tokens, rotating refresh tokens (hashed)                  | Account takeover                           |
| Configuration snapshot     | Valkey and the gateway's data dir; holds only encrypted secrets and hashes | Routing integrity                          |

## Trust boundaries

1. **Internet → Traefik → gateway** (`api.`): virtual-key holders, possibly hostile tenants.
2. **Internet → Traefik → control-api** (`admin.`, `portal.`, dashboard): users of different
   organizations and roles.
3. **Gateway → providers**: third-party APIs and anything a tenant configures as a provider.
4. **Identity providers → control-api**: OIDC and SAML assertions, SCIM provisioning.
5. **Internal network**: gateway ↔ Valkey, control-api ↔ Postgres/Valkey, worker. The gateway has
   no Postgres access (ADR-006).
6. **Build and release**: dependencies, base images, CI, the image registry.
7. **Operator extensions**: provider plugins.

## Threats and mitigations

| #   | Boundary | STRIDE | Threat                                                                      | Mitigation                                                                                                                                                                                                                                                                         | Residual risk                                                                                             |
| --- | -------- | ------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| T1  | 1        | S      | Stolen or guessed virtual key                                               | Peppered SHA-256 hashes, 1 key shown once, expiry and rotation, per-key model allowlist, rate limits and budgets                                                                                                                                                                   | A leaked key works until revoked; alerts on spend spikes                                                  |
| T2  | 1        | D      | Request floods, huge bodies, slow streams                                   | Per-key/project/team RPM and TPM limits, concurrency bulkheads, 20 MB body limit (25 MB for audio), first-byte and idle timeouts                                                                                                                                                   | Volumetric DDoS is left to the edge                                                                       |
| T3  | 1        | E      | Using another organization's models                                         | Router resolves models inside the key's organization; marketplace models only when public                                                                                                                                                                                          | —                                                                                                         |
| T4  | 3        | I      | **SSRF**: a tenant points a provider at cloud metadata or internal services | In production, customer providers and proxies must resolve to public addresses: checked when saved (control-api) and again when connecting (gateway lookup guard, which also stops DNS rebinding). The platform organization may use private addresses.                            | A `socks5h://` proxy resolves names on the proxy side, outside the guard                                  |
| T5  | 2        | S      | Credential stuffing on the dashboard                                        | Login throttling (429 after repeated failures), MFA (TOTP, passkeys), SSO-only organizations                                                                                                                                                                                       | —                                                                                                         |
| T6  | 2        | E      | Privilege escalation through roles                                          | Permission matrix, custom roles only add permissions, "no role above your own", owners cannot be removed by SSO/SCIM, four-eyes approval for sensitive changes (opt-in)                                                                                                            | A single owner can still act alone when four-eyes is off                                                  |
| T7  | 2        | T      | CSRF, clickjacking, XSS                                                     | Bearer access tokens (not cookies) for the API, refresh cookie `SameSite=Strict` on `/auth`, CSP `script-src 'self'`, `frame-ancestors 'none'`, React escaping                                                                                                                     | —                                                                                                         |
| T8  | 4        | S      | Forged SSO identities                                                       | OIDC: PKCE, state bound to the browser, nonce, issuer/audience/JWKS checks, verified email. SAML: signed assertion from the configured certificate, audience, InResponseTo consumed once, replayed assertions refused. Existing accounts of other organizations are never adopted. | A compromised IdP controls its own organization (by design)                                               |
| T9  | 4        | E      | SCIM token abuse                                                            | Per-organization tokens, hashed, owner-only, revocable; cannot assign OWNER or touch owners                                                                                                                                                                                        | —                                                                                                         |
| T10 | 5        | I      | Secrets in the snapshot or logs                                             | Snapshot carries ciphertext and hashes only; logs redact keys and proxy credentials                                                                                                                                                                                                | Host compromise exposes `MASTER_KEY`                                                                      |
| T11 | 5        | T      | Wallet manipulation                                                         | Double-entry ledger with DB triggers (zero-sum, append-only), idempotent usage events, Valkey holds reconciled by the worker                                                                                                                                                       | —                                                                                                         |
| T12 | 6        | T      | Malicious or vulnerable dependency or base image                            | Lockfile with frozen installs, Trivy dependency and image scans fail CI on Critical, SBOM per image, pinned actions and scanner images                                                                                                                                             | Zero-days before an advisory exists                                                                       |
| T13 | 6        | S      | Tampered image in the registry                                              | Keyless cosign signatures bound to the CI workflow identity, SBOM attestation; deployers verify before pulling                                                                                                                                                                     | Deployers who skip verification                                                                           |
| T14 | 7        | E      | A provider plugin reaching into the gateway                                 | Plugins are off unless listed, run in a V8 context without Node APIs, exchange JSON only, have a CPU limit and may only target allowed hosts                                                                                                                                       | `node:vm` is not a hard boundary against deliberately hostile code; plugins are installed by the operator |
| T15 | 1/3      | R      | Disputed usage or charges                                                   | Usage events with request IDs, per-attempt records, audit log for configuration changes, invoices from the ledger                                                                                                                                                                  | —                                                                                                         |

## Out of scope

Physical security of hosts, the operator's cloud account, and the security of the providers
themselves.

## Review

Revisit this model when a new boundary appears: a new inbound protocol, a new kind of
tenant-supplied URL or code, or a new place secrets are stored.

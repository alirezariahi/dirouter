# Enterprise security

> Code: `apps/control-api/src/auth/{mfa.service,totp,webauthn}.ts`, `apps/control-api/src/security`, `apps/control-api/src/rbac` (cards 14.1 to 14.5). Dashboard: **Account** (your own second factor) and **Security** (organization policy). SSO has its own page: [sso.md](sso.md).

## 1. Multi-factor authentication (14.1)

- **TOTP** (RFC 6238, SHA-1, 6 digits, 30-second step; the previous and next step are accepted for clock skew) and **passkeys** (WebAuthn).
- Enrollment: `POST /auth/mfa/setup` returns the secret and an `otpauth://` link; `POST /auth/mfa/verify` with a code activates it and returns **ten recovery codes, shown once**. The TOTP secret is stored encrypted with `MASTER_KEY`, bound to the user id.
- Login: when the account has MFA, `POST /auth/login` without `mfaCode` answers `mfa_required` (401); the dashboard then asks for the code. `mfaCode` is a TOTP code or a recovery code.
- **No replay, no guessing.** Each accepted TOTP code burns its time step: the same code (or an older one) is rejected afterwards. A wrong `mfaCode` counts towards the same lockout as a wrong password (10 failures in 15 minutes per account), and so do wrong codes on `/auth/mfa/disable` and on replacing the authenticator.
- **Replacing the authenticator** needs the current one: when MFA is already enabled, `POST /auth/mfa/setup` requires `{"code": "<current TOTP or recovery code>"}`. The new secret only takes effect after `POST /auth/mfa/verify`; until then the existing secret stays active.
- **Passkeys** require user presence and user verification (PIN or biometric) at registration and at every login, and a signature counter that goes backwards is rejected as a possible clone. Usernameless (discoverable) login is supported: `POST /auth/webauthn/login/options` without an email.
- Sign-in methods can only be changed from a session opened with your own password or passkey, not from an SSO session.
- Accepting an invitation with an existing account is guarded like a login: same lockout, and `mfaCode` is required when the account has MFA.
- **Recovery codes are single-use.** Only SHA-256 hashes are stored; a used code is removed with a conditional update, so two simultaneous logins with the same code cannot both succeed.

### Mandatory MFA per role

`PATCH /orgs/:orgId/security` with `{"mfaRequiredRoles": ["OWNER", "ADMIN"]}` (permission `security:write`).

A member whose role is listed gets `mfa_enrollment_required` (403) on **every** route of that organization unless the session satisfies the policy. They can still sign in and reach `/auth/mfa` and `/auth/webauthn` to enroll, so the policy cannot lock anyone out; nothing in the organization is readable or writable until they do.

What satisfies the policy depends on how the session was opened (the access token carries it as the `amr` claim):

| Session opened with | Satisfied when                                                                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| password            | a confirmed TOTP secret exists (login then always asks for the code). A registered passkey alone does not count, because password login never asks for it |
| passkey             | always (user verification is required)                                                                                                                    |
| SSO                 | always; the organization's identity provider owns the second factor, and the session is valid only in that organization                                   |

In SSO-only organizations (`passwordLoginDisabled` **and** at least one enabled SSO connection) the policy does not apply. If the last connection is disabled or removed, password login works again and so does the policy.

## 2. Custom roles and the permission matrix (14.3)

Every route declares one permission (`providers:write`, `audit:read`, …); a route without a declared permission is closed. The four built-in roles are defined as permission sets in `rbac/permissions.ts` (the single source for the guard, tests and [rbac.md](rbac.md)).

A **custom role** is a named list of permissions attached to a membership in addition to its base role:

```bash
curl -X POST "$ADMIN/orgs/$ORG/custom-roles" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"Billing viewer","permissions":["usage:read","audit:read"]}'
```

The effective permissions are the **union** of the base role and the custom role. A custom role can only add; it never removes what the base role grants. Unknown permission names are rejected.

Rules that prevent privilege escalation:

- A custom role may only contain permissions its editor holds; the same applies to editing or deleting an existing role (the editor must hold everything it grants) and to assigning a custom role to a member.
- Nobody can change their own role or custom role.
- A member can only be changed or removed by someone who is not below them: neither by base role nor by the permissions of the target's custom role. The owner rules are unchanged (only an owner deals with owners; the last owner stays).

## 3. Audit log (14.4)

- Written for sign-in policy changes, MFA enable/replace/disable, passkey add/remove, SSO connections and SSO logins, custom roles, providers, credentials, keys, models, guardrails, cache purges, manual health resets and key rotation, with the actor, target, a diff of changed fields and the client IP. Secrets never appear in the diff.
- **Append-only**: a database trigger (`audit_logs_append_only`) rejects `UPDATE` and `DELETE` on the table, even for the application's own role.
- Read: `GET /orgs/:orgId/audit?action=provider.&from=&to=&actorUserId=&targetType=&limit=&cursor=` (permission `audit:read`). `action` is a prefix filter; pagination uses the returned `nextCursor`.
- Export: `GET /orgs/:orgId/audit/export` returns CSV (up to 50,000 rows) with the same filters.

## 4. Rotating `MASTER_KEY` (14.5)

`MASTER_KEY` is a keyring; the highest version encrypts, every listed version can decrypt.

1. Generate a new key and add it with the next version number: `MASTER_KEY=1:<old>,2:<new>`.
2. Restart control-api, gateway and worker. New secrets are now written with version 2; existing ones still decrypt with version 1.
3. As an **OWNER**, run `POST /orgs/:orgId/security/rotate-key` (or Security → _MASTER_KEY rotation_). Provider credentials, SSO client secrets and TOTP secrets not yet on the current version are decrypted and re-encrypted. Everything is decrypted first: if a single value cannot be decrypted, nothing is written. Each write is conditional on the ciphertext that was read, so a secret replaced during the rotation is never overwritten with its old value; the rotation retries and, if secrets keep changing, answers `conflict` without writing anything.
4. The response reports how many items were re-encrypted. When a second run reports `rotated: 0`, the old key can be removed from `MASTER_KEY` and the services restarted.

The gateway keeps serving during rotation: it decrypts with whichever version a credential carries, and the re-encrypted secrets reach it through the normal config snapshot.

Provider API keys themselves are rotated on the Providers page (add the new credential, disable the old one); see [control-api/providers.md](control-api/providers.md).

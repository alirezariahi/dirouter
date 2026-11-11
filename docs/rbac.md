[English](rbac.md) · [فارسی](rbac.fa.md)

# Access control (RBAC)

Code: `apps/control-api/src/rbac` and `apps/control-api/src/orgs` · Test: `orgs.integration.test.ts` · Card 3.5

## Roles and permissions

Roles are at the **organization** level (`memberships` table): OWNER, ADMIN, MEMBER and VIEWER. This matrix is built from `permissions.ts`:

| Permission        | OWNER | ADMIN | MEMBER | VIEWER |
| ----------------- | ----- | ----- | ------ | ------ |
| `org:read`        | ✅    | ✅    | ✅     | ✅     |
| `org:write`       | ✅    | ✅    | —      | —      |
| `members:read`    | ✅    | ✅    | ✅     | ✅     |
| `members:write`   | ✅    | ✅    | —      | —      |
| `invites:write`   | ✅    | ✅    | —      | —      |
| `teams:read`      | ✅    | ✅    | ✅     | ✅     |
| `teams:write`     | ✅    | ✅    | —      | —      |
| `projects:read`   | ✅    | ✅    | ✅     | ✅     |
| `projects:write`  | ✅    | ✅    | ✅     | —      |
| `providers:read`  | ✅    | ✅    | ✅     | ✅     |
| `providers:write` | ✅    | ✅    | —      | —      |
| `keys:read`       | ✅    | ✅    | ✅     | ✅     |
| `keys:write`      | ✅    | ✅    | ✅     | —      |
| `models:read`     | ✅    | ✅    | ✅     | ✅     |
| `models:write`    | ✅    | ✅    | —      | —      |
| `usage:read`      | ✅    | ✅    | ✅     | ✅     |
| `audit:read`      | ✅    | ✅    | ✅     | ✅     |

Additional rules in the service, separate from the matrix:

- No one grants a role **higher than their own**, or invites with one.
- Only OWNER grants, takes away or removes an OWNER member's role.
- The **last OWNER** of an organization cannot be demoted or removed (409 `conflict`).
- The `providers`, `keys`, `models`, `usage` and `audit` permissions are already defined for cards 3.6 to 3.10. `providers:read` never returns a secret.

## How it is applied

- All organization routes are under `/api/v1/orgs/:orgId/…` and sit behind `AccessGuard` (JWT) and `OrgGuard`.
- `OrgGuard` reads the user's membership in `:orgId` from the DB. **Not being a member means 404**, not 403, so that the existence of another organization is not revealed.
- Each handler declares its permission with `@RequirePermission('teams:write')`. **A route that declares no permission is closed** (fail closed).
- **Data isolation**: all queries are limited to the `organizationId` of the verified organization. A team or project id from another organization returns 404 on your organization's path.

## Endpoints

| Route                                                                                | Permission                        |
| ------------------------------------------------------------------------------------ | --------------------------------- |
| `GET /orgs/:orgId`, `PATCH /orgs/:orgId`                                             | `org:read`, `org:write`           |
| `GET /members`, `PATCH /members/:userId` (`{role}`), `DELETE /members/:userId`       | `members:read`, `members:write`   |
| `GET /invitations`, `POST /invitations` (`{email, role}`), `DELETE /invitations/:id` | `members:read`, `invites:write`   |
| `GET/POST /teams`, `PATCH/DELETE /teams/:id`                                         | `teams:read`, `teams:write`       |
| `GET/POST /projects`, `PATCH/DELETE /projects/:id`                                   | `projects:read`, `projects:write` |
| `POST /auth/invitations/accept` (`{token, name?, password}`)                         | Public, with the invitation token |

## Invitations

- `POST /invitations` returns the link `PUBLIC_DASHBOARD_URL/invite/<token>`. The token is shown **only once**, and only its hash is stored in the DB.
- The link lasts 7 days and is single-use (a conditional UPDATE on `accepted_at IS NULL`). A cancelled or expired link returns 404.
- If the invited email already has an account, **that account's password is required**, so holding the link is not enough to take over someone else's account. Otherwise a new user is created with a name and a password (at least 10 characters).

## Deletion and audit

- Deleting a team or project is a soft delete (`deleted_at`, and the slug is released). Projects of a deleted team remain without a team.
- Every change is recorded in `audit_logs` for the same organization: `team.*`, `project.*`, `member.*`, `invitation.*` and `org.updated`.

## Tests

`apps/control-api/src/orgs/orgs.integration.test.ts` runs over HTTP against real Postgres and Valkey, in the integration job in CI:

1. VIEWER gets 200 on all read routes and 403 on all 11 write operations.
2. The owner of organization A gets 404 on all organization B routes, even with team B's id on A's path.
3. MEMBER creates projects but not teams or invitations.
4. ADMIN cannot create an OWNER or change an OWNER, and the last OWNER cannot be demoted.
5. The invitation link is single-use, expires, and does not accept an existing account without its password.
6. The audit of each organization is recorded separately.

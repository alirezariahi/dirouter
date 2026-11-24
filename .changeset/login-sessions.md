---
'@dirouter/control-api': minor
'@dirouter/dashboard': minor
---

Sign-in sessions: `GET /auth/sessions` lists the signed-in user's active sessions with device,
address and last activity; `DELETE /auth/sessions/{id}` ends one and
`POST /auth/sessions/revoke-all` signs out everywhere else (or everywhere with
`includeCurrent: true`). Administrators can list and end a member's sessions under
`/orgs/{orgId}/members/{userId}/sessions`. Ending a session revokes its refresh token at once, and
access tokens now carry their session id (`sid`), so they are refused as soon as their session is
revoked, also after logout, a password change or a reused refresh token, instead of staying valid
for up to 15 minutes. Every revocation is audited. The account page lists the sessions and the
organization page has a "Sign out everywhere" button per member.

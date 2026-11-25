---
'@dirouter/control-api': patch
'@dirouter/worker': patch
'@dirouter/db': patch
---

Security review fixes. Alert channel tests are limited to one per channel per minute and ten per
organization per hour (429 with `Retry-After`), an email test needs a verified sender, and its
subject is fixed. A change request made with a management token records the person behind the
token, who cannot approve it, and neither can the creator of the requesting service account.
Creating service accounts needs a verified email address, keys created with a management token
check the token's creator, and users who accept an invitation that was not delivered by email start
unverified. Open live streams re-check the session, membership or token every 30 seconds and are
capped at five per user. `TRUST_PROXY` (default one hop, the bundled Traefik) replaces trusting
every proxy for the client address. Organization administrators no longer see a member's session
addresses or devices, and the member session routes are closed to management tokens. Catalog price
proposals are claimed atomically before they are applied; a migration marks catalog models that were
priced by hand before catalog sync as overridden; `queue_length` alert rules are kept to the
platform organization.

One module per sprint 5 card, named after the card key (`30.1.mjs`, `32.2.mjs`, …). Each exports
`register(ctx)`; `ctx` has `scenario(name, fn)`, `cleanups`, `api`, `org(method, path, body,
expected)`, `ORG` and `createKey(name)`. Shared helpers (requests, SQL, Valkey, waiting) come from
`../harness.mjs`. Run one card with `node scripts/e2e/sprint-5.mjs 30.1`.

# Local Documentation Guide

All documentation is in English. Detailed guides live in `code/docs/`. See the [documentation policy](../CONTRIBUTING.md#documentation-policy).

- [README](../README.md)
- [Dashboard user guide and concepts](user-guide/README.md) — all pages, common scenarios, and local screenshots
- [Sprint 2 feature guide](sprint-2.md) — routing, caching, security, guardrails, alerts, tracing, HA; what is verified and what is not
- Migration guides: [from OpenRouter](migrate-from-openrouter.md) and [from LiteLLM](migrate-from-litellm.md)
- Sprint 5 gateway features: [request-level routing](concepts/request-routing.md), [routing policies](concepts/routing-policies.md), [Files and Batch](gateway/batch.md), [videos](gateway/videos.md), [moderations](gateway/moderations.md), [rerank](gateway/rerank.md), [Realtime](gateway/realtime.md), [legacy endpoints](gateway/legacy-endpoints.md), [pass-through](gateway/passthrough.md), [web search](gateway/web-search.md), [upstream balances](upstream-balances.md); the official SDK checks are in `scripts/e2e/sprint-5/34.1.mjs`
- [Operational runbook](runbook.md) — symptoms, diagnosis, action, and verification for service incidents
- [Contribution guide](../CONTRIBUTING.md)
- [Architecture](architecture.md)
- [Glossary](glossary.md)
- [CI guide](ci.md)
- [ADRs](adr/README.md)
- [Competitor research](research/feature-comparison.md); a local copy also lives in [en/research](en/research/feature-comparison.md)
- [Sprint plan](board/README.md); a local copy also lives in [en/board](en/board/README.md)
- [Local CI verification note](en/ci-verification.md)

The board login information is in `board/dirouter-board.json`, and the scripts that build it are in `tools/board/`; both are local. The importable board file is an old snapshot; the current state of the work is read from the live board.

## Documentation site

`apps/docs` publishes `docs/` and `adr/` as a searchable English site (Astro Starlight) (card 22.5).
Nothing is copied by hand:

- `scripts/sync.mjs` converts every `name.md` into one page. The H1 becomes the title, links between documents
  become site links, and links to other repository files go to GitHub. `adr/` appears under
  `/decisions/`.
- The API reference (`/api/reference/`) is generated from `apps/dashboard/openapi.json`.
- The build ends with a link check: every document must have its page, and no page may link to a
  missing one. CI runs it whenever `docs/`, `adr/` or `apps/docs` change.
- It needs Node 22.23.4 or newer (Astro 7). Run it locally with `pnpm --filter @dirouter/docs dev`; deploy it with
  `docker compose --profile docs up -d docs`, served at `docs.<DOMAIN>` behind Traefik.

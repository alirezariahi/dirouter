[English](DOCUMENTATION.md) · [فارسی](DOCUMENTATION.fa.md)

# Local Documentation Guide

Every document exists in two files: an English `.md` file and a Persian `.fa.md` file. Detailed guides live in `code/docs/`. See the [documentation policy](../CONTRIBUTING.md#documentation-policy).

- [README](../README.md) — [Persian version](../README.fa.md)
- [Dashboard user guide and concepts](user-guide/README.md) — all pages, common scenarios, and local screenshots
- [Sprint 2 feature guide](sprint-2.md) — routing, caching, security, guardrails, alerts, tracing, HA; what is verified and what is not
- [Operational runbook](runbook.md) — symptoms, diagnosis, action, and verification for service incidents
- [Contribution guide](../CONTRIBUTING.md) — [Persian version](../CONTRIBUTING.fa.md)
- [Architecture](architecture.md) — [Persian version](architecture.fa.md)
- [Glossary](glossary.md) — [Persian version](glossary.fa.md)
- [CI guide](ci.md) — [Persian version](ci.fa.md)
- [ADRs](adr/README.md) — [Persian version](adr/README.fa.md)
- [Competitor research](research/feature-comparison.md) — [Persian version](research/feature-comparison.fa.md); a local copy also lives in [en/research](en/research/feature-comparison.md)
- [Sprint plan](board/README.md) — [Persian version](board/README.fa.md); a local copy also lives in [en/board](en/board/README.md)
- [Local CI verification note](en/ci-verification.md)

The board login information is in `board/dirouter-board.json`, and the scripts that build it are in `tools/board/`; both are local. The importable board file is an old snapshot; the current state of the work is read from the live board.

## Documentation site

`apps/docs` publishes `docs/` and `adr/` as a searchable site (Astro Starlight), English at `/` and
Persian (RTL) at `/fa/` (card 22.5). Nothing is copied by hand:

- `scripts/sync.mjs` converts every `name.md` / `name.fa.md` pair into the two pages of one
  document. The H1 becomes the title, the language-switch line is dropped, links between documents
  become site links, and links to other repository files go to GitHub. `adr/` appears under
  `/decisions/`.
- The API reference (`/api/reference/`) is generated from `apps/dashboard/openapi.json`.
- The build ends with a link check: every document must have its page, and no page may link to a
  missing one. CI runs it whenever `docs/`, `adr/` or `apps/docs` change.
- Run it locally with `pnpm --filter @dirouter/docs dev`; deploy it with
  `docker compose --profile docs up -d docs`, served at `docs.<DOMAIN>` behind Traefik.

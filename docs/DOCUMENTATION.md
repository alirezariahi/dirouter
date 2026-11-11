[English](DOCUMENTATION.md) · [فارسی](DOCUMENTATION.fa.md)

# Local Documentation Guide

Every document exists in two files: an English `.md` file and a Persian `.fa.md` file. Detailed guides live in `code/docs/`. See the [documentation policy](../CONTRIBUTING.md#documentation-policy).

- [README](../README.md) — [Persian version](../README.fa.md)
- [Dashboard user guide and concepts](user-guide/README.md) — all pages, common scenarios, and local screenshots
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

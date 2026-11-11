[English](ci-verification.md) · [فارسی](ci-verification.fa.md)

# Local CI verification

## Acceptance status

Local verification on 2026-11-07: all 40 quality/build tasks passed, along with the 62 existing unit tests, nine package-selection tests (including real Git and Turbo), and two real-service tests. Root/CI ESLint, Prettier, `actionlint`, and `git diff --check` also passed.

All five images were produced on an ARM64 host, and the control-api image passed its health check. The Docker client for control-api did not exit after build/export completed and was stopped; that invocation does not count as a fully successful Docker command. The Linux AMD64 runner and GHCR publication remain unverified.

Local checks do not replace a GitHub run. The criterion "the pipeline is green on main" can be confirmed only after committing/pushing and observing a successful run on main. The unfinished card 2.1 Dockerfiles must also be present in the checkout; local-only files are not available to the runner. Code-review approval is a separate step and is not inferred from tool results.

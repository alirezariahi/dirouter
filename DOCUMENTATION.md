# Documentation

All documentation versioned in this repository is English. The repository contains public project documentation; local translations and personal planning material are kept outside it.

## Public guides

- [Project README](README.md): prerequisites, quick start, commands, and repository layout.
- [Contributing](CONTRIBUTING.md): development workflow, quality tools, commits, and documentation policy.
- [Architecture](ARCHITECTURE.md): target components, request flow, accounting, configuration, and resilience.
- [Glossary](GLOSSARY.md): domain vocabulary used by code, APIs, and the dashboard.
- [Architecture Decision Records](adr/README.md): accepted decisions and a template for future records.
- [CI](CI.md): the prepared pipeline design, integration services, image builds, and registry publishing.

The architecture describes the target system. Its presence does not imply that all features have been implemented; see the project README for current status.

## Local material

The local project layout keeps `code/` (this Git repository) next to `docs/` (private documentation). Persian counterparts, competitor research, sprint plans, board exports, generator scripts, and verification notes live in that sibling `../docs/` directory. They are outside the Git root and Docker build context, and are not included in a clone.

Keep public Markdown guides at the repository root or in `adr/`; do not create a `docs/` directory inside `code/`.

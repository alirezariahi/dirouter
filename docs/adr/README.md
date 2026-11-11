[English](README.md) · [فارسی](README.fa.md)

# Architecture Decision Records

Architecture decisions are recorded using the [MADR](https://adr.github.io/madr/) template. Each ADR has three main sections: **Context**, **Decision** and **Consequences**.

| #                                      | Title                                                            | Status   |
| -------------------------------------- | ---------------------------------------------------------------- | -------- |
| [001](0001-gateway-nestjs-fastify.md)  | Gateway with NestJS on Fastify and overhead reduction strategies | Accepted |
| [002](0002-postgresql-prisma.md)       | PostgreSQL 17 + Prisma                                           | Accepted |
| [003](0003-valkey.md)                  | Valkey for counters, cache and pub/sub                           | Accepted |
| [004](0004-traefik-reverse-proxy.md)   | Traefik v3 as reverse proxy                                      | Accepted |
| [005](0005-bullmq-event-queue.md)      | BullMQ for the event queue                                       | Accepted |
| [006](0006-data-plane-independence.md) | the data plane does not depend on the control plane              | Accepted |

## Adding a new ADR

1. Copy [template.md](template.md) with the next number: `NNNN-short-title.md`.
2. Set the status to `Proposed` and review it in a PR.
3. After approval, set the status to `Accepted` and add it to the table above.
4. An accepted ADR is not edited. To change a decision, write a new ADR and set the previous one to `Superseded by ADR-NNN`.

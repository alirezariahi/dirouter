# Architecture Decision Records

Decisions follow the [MADR](https://adr.github.io/madr/) format. Each ADR contains three main sections: **Context**, **Decision**, and **Consequences**.

| Number                                 | Title                                                     | Status   |
| -------------------------------------- | --------------------------------------------------------- | -------- |
| [001](0001-gateway-nestjs-fastify.md)  | Gateway with NestJS on Fastify and a lightweight hot path | Accepted |
| [002](0002-postgresql-prisma.md)       | PostgreSQL 17 + Prisma                                    | Accepted |
| [003](0003-valkey.md)                  | Valkey for counters, cache, and pub/sub                   | Accepted |
| [004](0004-traefik-reverse-proxy.md)   | Traefik v3 as reverse proxy                               | Accepted |
| [005](0005-bullmq-event-queue.md)      | BullMQ for the event queue                                | Accepted |
| [006](0006-data-plane-independence.md) | Data-plane independence from the control plane            | Accepted |

## Adding an ADR

1. Copy [template.md](template.md) using the next number: `NNNN-short-title.md`.
2. Set its status to `Proposed` and review it in a pull request.
3. Once approved, change the status to `Accepted` and add it to the table.
4. To change an accepted decision, write a new ADR and mark the old record `Superseded by ADR-NNNN`; preserve the decision history.

Keep the versioned record in English. Local Persian counterparts belong under the sibling `../docs/adr/` directory and are excluded from Git.

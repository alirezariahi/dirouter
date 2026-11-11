[English](#english) · [فارسی](#persian)

<a id="english"></a>

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

All documentation in this repository is bilingual (English and Persian), and detailed guides live in code/docs/. See [CONTRIBUTING.md](../CONTRIBUTING.md).

---

<a id="persian"></a>

# یادداشت‌های تصمیم معماری (ADR)

تصمیم‌ها از قالب [MADR](https://adr.github.io/madr/) پیروی می‌کنند. هر ADR سه بخش اصلی دارد: **Context** (زمینه)، **Decision** (تصمیم) و **Consequences** (پیامدها).

| شماره                                  | عنوان                                             | وضعیت       |
| -------------------------------------- | ------------------------------------------------- | ----------- |
| [001](0001-gateway-nestjs-fastify.md)  | Gateway با NestJS روی Fastify و مسیر پرترافیک سبک | پذیرفته‌شده |
| [002](0002-postgresql-prisma.md)       | PostgreSQL 17 + Prisma                            | پذیرفته‌شده |
| [003](0003-valkey.md)                  | Valkey برای شمارنده‌ها، cache و pub/sub           | پذیرفته‌شده |
| [004](0004-traefik-reverse-proxy.md)   | Traefik v3 به‌عنوان reverse proxy                 | پذیرفته‌شده |
| [005](0005-bullmq-event-queue.md)      | BullMQ برای صف رویدادها                           | پذیرفته‌شده |
| [006](0006-data-plane-independence.md) | استقلال صفحه داده از صفحه کنترل                   | پذیرفته‌شده |

## افزودن یک ADR

1. [template.md](template.md) را با شماره بعدی کپی کنید: `NNNN-short-title.md`.
2. وضعیت را `Proposed` بگذارید و آن را در یک pull request بررسی کنید.
3. پس از تأیید، وضعیت را به `Accepted` تغییر دهید و به جدول اضافه کنید.
4. برای تغییر یک تصمیم پذیرفته‌شده، یک ADR جدید بنویسید و رکورد قدیمی را با `Superseded by ADR-NNNN` علامت بزنید؛ تاریخچه تصمیم‌ها حفظ می‌شود.

تمام مستندات این مخزن دوزبانه (انگلیسی و فارسی) است و راهنماهای تفصیلی در code/docs/ قرار دارند. به [CONTRIBUTING.md](../CONTRIBUTING.md) مراجعه کنید.

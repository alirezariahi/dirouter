[English](#english) · [فارسی](#persian)

<a id="english"></a>

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

---

<a id="persian"></a>

# Architecture Decision Records

تصمیم‌های معماری با قالب [MADR](https://adr.github.io/madr/) ثبت می‌شوند. هر ADR سه بخش اصلی دارد: **زمینه (Context)**، **تصمیم (Decision)** و **پیامدها (Consequences)**.

| #                                      | عنوان                                                  | وضعیت       |
| -------------------------------------- | ------------------------------------------------------ | ----------- |
| [001](0001-gateway-nestjs-fastify.md)  | گیت‌وی با NestJS روی Fastify و راهکارهای کاهش overhead | پذیرفته‌شده |
| [002](0002-postgresql-prisma.md)       | PostgreSQL 17 + Prisma                                 | پذیرفته‌شده |
| [003](0003-valkey.md)                  | Valkey برای شمارنده، کش و pub/sub                      | پذیرفته‌شده |
| [004](0004-traefik-reverse-proxy.md)   | Traefik v3 به‌عنوان ریورس پراکسی                       | پذیرفته‌شده |
| [005](0005-bullmq-event-queue.md)      | BullMQ برای صف رویداد                                  | پذیرفته‌شده |
| [006](0006-data-plane-independence.md) | data plane به control plane وابسته نیست                | پذیرفته‌شده |

## افزودن ADR جدید

1. فایل [template.md](template.md) را با شمارهٔ بعدی کپی کنید: `NNNN-short-title.md`.
2. وضعیت را `پیشنهادی` بگذارید و در PR بازبینی کنید.
3. بعد از تأیید، وضعیت را `پذیرفته‌شده` کنید و به جدول بالا اضافه کنید.
4. ADR پذیرفته‌شده ویرایش نمی‌شود؛ برای تغییر تصمیم، ADR جدید بنویسید و قبلی را `جایگزین‌شده با ADR-NNN` کنید.

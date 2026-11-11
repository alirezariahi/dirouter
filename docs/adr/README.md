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

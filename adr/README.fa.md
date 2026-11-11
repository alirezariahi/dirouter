[English](README.md) · [فارسی](README.fa.md)

<div dir="rtl">

# یادداشت‌های تصمیم معماری (ADR)

تصمیم‌ها از قالب [MADR](https://adr.github.io/madr/) پیروی می‌کنند. هر ADR سه بخش اصلی دارد: **Context** (زمینه)، **Decision** (تصمیم) و **Consequences** (پیامدها).

| شماره                                     | عنوان                                             | وضعیت       |
| ----------------------------------------- | ------------------------------------------------- | ----------- |
| [001](0001-gateway-nestjs-fastify.fa.md)  | Gateway با NestJS روی Fastify و مسیر پرترافیک سبک | پذیرفته‌شده |
| [002](0002-postgresql-prisma.fa.md)       | PostgreSQL 17 + Prisma                            | پذیرفته‌شده |
| [003](0003-valkey.fa.md)                  | Valkey برای شمارنده‌ها، cache و pub/sub           | پذیرفته‌شده |
| [004](0004-traefik-reverse-proxy.fa.md)   | Traefik v3 به‌عنوان reverse proxy                 | پذیرفته‌شده |
| [005](0005-bullmq-event-queue.fa.md)      | BullMQ برای صف رویدادها                           | پذیرفته‌شده |
| [006](0006-data-plane-independence.fa.md) | استقلال صفحه داده از صفحه کنترل                   | پذیرفته‌شده |

## افزودن یک ADR

1. [template.md](template.fa.md) را با شماره بعدی کپی کنید: `NNNN-short-title.md`.
2. وضعیت را `Proposed` بگذارید و آن را در یک pull request بررسی کنید.
3. پس از تأیید، وضعیت را به `Accepted` تغییر دهید و به جدول اضافه کنید.
4. برای تغییر یک تصمیم پذیرفته‌شده، یک ADR جدید بنویسید و رکورد قدیمی را با `Superseded by ADR-NNNN` علامت بزنید؛ تاریخچه تصمیم‌ها حفظ می‌شود.

هر سند دوزبانه است: یک فایل انگلیسی با پسوند `.md` و یک فایل فارسی با پسوند `.fa.md` کنار هم قرار دارند و راهنماهای تفصیلی در `code/docs/` نگهداری می‌شوند. [سیاست مستندات](../CONTRIBUTING.fa.md#documentation-policy-fa) را در [CONTRIBUTING.fa.md](../CONTRIBUTING.fa.md) ببینید.

</div>

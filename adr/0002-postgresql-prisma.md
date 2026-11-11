[English](#english) · [فارسی](#persian)

<a id="english"></a>

# ADR-0002: PostgreSQL 17 + Prisma

- **Status:** Accepted
- **Date:** 2026-11-07
- **Decision makers:** DiRouter team

## Context

The control plane needs a relational database for organizations, users, keys, providers, models, combos, versioned configuration snapshots, and the financial ledger. Request logs also need storage, search, and dashboard aggregation. Initial research proposed ClickHouse for logs, but MVP traffic is lower and one fewer database simplifies operations.

### Decision drivers

- ACID transactions and integrity for the ledger and configuration.
- Versioned migrations from a single source of truth.
- Existing team experience with Prisma.
- Simple Docker Compose deployment and a later HA path.
- A growth path for high-volume logs and pgvector semantic caching.

### Considered options

1. PostgreSQL + Prisma.
2. PostgreSQL + Drizzle.
3. PostgreSQL for configuration and ClickHouse for logs from day one.
4. MySQL.

## Decision

Use **PostgreSQL 17** with **Prisma** as ORM and migration tooling in `@dirouter/db`.

- Store request logs in a natively **monthly-partitioned table**. Dashboard queries use **hourly and daily aggregate tables**.
- Use `$queryRaw` and hand-written migration SQL for operations Prisma does not model well: partitions, aggregate upserts, and bulk `ON CONFLICT DO NOTHING` writes.
- Monetary storage follows the implemented contracts and schema: USD `Decimal(18,8)`, decimal strings at API boundaries, and BigInt fixed-point arithmetic in shared helpers. This corrects the initial draft's obsolete integer-microdollar notation; no floating-point money arithmetic is allowed.
- Place PgBouncer in front of PostgreSQL in production.

## Consequences

### Positive

- One database covers the MVP, simplifying backups and operations.
- Schema and client types come from one source, `schema.prisma`.
- pgvector can run in the same database for semantic caching.

### Negative

- Prisma does not model partitioning. Some DDL is manual and must remain compatible with `prisma migrate`.
- Prisma client adds overhead; high-volume worker writes use bulk SQL inserts.
- Aggregating raw logs becomes costly as volume grows to millions of rows per day.

### Follow-up

- If logs exceed roughly 50 million rows per month, write a new ADR for moving logs and analytics to ClickHouse.
- Gateway must not depend on `@dirouter/db` (ADR-006).

---

<a id="persian"></a>

# ADR-0002: PostgreSQL 17 + Prisma

- **Status:** Accepted
- **تاریخ:** 2026-11-07
- **تصمیم‌گیرندگان:** تیم DiRouter

## زمینه

صفحه کنترل به یک پایگاه داده رابطه‌ای برای سازمان‌ها، کاربران، کلیدها، providerها، مدل‌ها، comboها، snapshotهای نسخه‌دار پیکربندی و دفتر مالی نیاز دارد. لاگ‌های درخواست هم نیاز به ذخیره‌سازی، جست‌وجو و تجمیع برای داشبورد دارند. تحقیق اولیه ClickHouse را برای لاگ‌ها پیشنهاد می‌کرد، اما ترافیک MVP پایین‌تر است و داشتن یک پایگاه داده کمتر، عملیات را ساده‌تر می‌کند.

### عوامل تصمیم

- تراکنش‌های ACID و یکپارچگی برای دفتر مالی و پیکربندی.
- migrationهای نسخه‌دار از یک منبع حقیقت واحد.
- تجربه موجود تیم با Prisma.
- استقرار ساده با Docker Compose و مسیر HA در آینده.
- مسیر رشد برای لاگ‌های حجیم و cache معنایی با pgvector.

### گزینه‌های بررسی‌شده

1. PostgreSQL + Prisma.
2. PostgreSQL + Drizzle.
3. PostgreSQL برای پیکربندی و ClickHouse برای لاگ‌ها از ابتدا.
4. MySQL.

## تصمیم

از **PostgreSQL 17** با **Prisma** به‌عنوان ORM و ابزار migration در `@dirouter/db` استفاده شود.

- لاگ‌های درخواست در یک **جدول پارتیشن‌بندی‌شده به‌صورت ماهانه** (native) ذخیره می‌شوند. پرس‌وجوهای داشبورد از **جدول‌های تجمیع ساعتی و روزانه** استفاده می‌کنند.
- برای عملیاتی که Prisma به‌خوبی مدل نمی‌کند، از `$queryRaw` و SQL دست‌نویس migration استفاده شود: partitionها، upsertهای تجمیع و نوشتن‌های دسته‌ای با `ON CONFLICT DO NOTHING`.
- ذخیره‌سازی پولی طبق قراردادها و schema پیاده‌سازی‌شده است: `Decimal(18,8)` برای USD، رشته‌های اعشاری در مرزهای API و حساب نقطه‌ثابت BigInt در کمک‌تابع‌های مشترک. این تصحیح نمادگذاری منسوخ «میلی‌دلار صحیح» در پیش‌نویس اولیه است؛ هیچ محاسبه پولی با ممیز شناور مجاز نیست.
- در محیط تولید، PgBouncer جلوی PostgreSQL قرار می‌گیرد.

## پیامدها

### مثبت

- یک پایگاه داده MVP را پوشش می‌دهد و پشتیبان‌گیری و عملیات را ساده می‌کند.
- schema و نوع‌های client از یک منبع واحد، یعنی `schema.prisma`، می‌آیند.
- pgvector می‌تواند برای cache معنایی در همان پایگاه داده اجرا شود.

### منفی

- Prisma پارتیشن‌بندی را مدل نمی‌کند. بخشی از DDL دستی است و باید با `prisma migrate` سازگار بماند.
- client مربوط به Prisma سربار دارد؛ نوشتن‌های حجیم worker از درج SQL دسته‌ای استفاده می‌کنند.
- با رشد حجم به میلیون‌ها ردیف در روز، تجمیع لاگ‌های خام پرهزینه می‌شود.

### پیگیری

- اگر لاگ‌ها از حدود ۵۰ میلیون ردیف در ماه بیشتر شوند، یک ADR جدید برای انتقال لاگ‌ها و تحلیل‌ها به ClickHouse نوشته می‌شود.
- gateway نباید به `@dirouter/db` وابسته باشد (ADR-006).

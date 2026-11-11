# ADR-0002: PostgreSQL 17 + Prisma

- **وضعیت:** پذیرفته‌شده
- **تاریخ:** 2026-11-07
- **تصمیم‌گیرندگان:** تیم DiRouter

## زمینه (Context)

control plane به یک دیتابیس رابطه‌ای برای سازمان، کاربر، کلید، provider، مدل، combo، snapshot نسخه‌دار config و ledger مالی نیاز دارد. لاگ درخواست‌ها هم باید ذخیره و در داشبورد جستجو و تجمیع شود. تحقیق اولیه ClickHouse را برای لاگ پیشنهاد کرد، اما در MVP حجم پایین‌تر است و یک دیتابیس کمتر یعنی عملیات ساده‌تر.

### معیارهای تصمیم (Decision Drivers)

- تراکنش و یکپارچگی برای ledger و config (ACID)
- migration نسخه‌دار از یک منبع واحد
- تجربهٔ قبلی تیم (Prisma در پروژه‌های دیگر)
- استقرار ساده در docker compose و امکان HA بعدی
- مسیر رشد برای لاگ حجیم و pgvector (semantic cache)

### گزینه‌های بررسی‌شده (Considered Options)

1. PostgreSQL + Prisma
2. PostgreSQL + Drizzle
3. PostgreSQL برای config و ClickHouse برای لاگ از روز اول
4. MySQL

## تصمیم (Decision)

**PostgreSQL 17** با **Prisma** به‌عنوان ORM و ابزار migration، در پکیج `@dirouter/db`.

- لاگ درخواست‌ها در جدول **پارتیشن‌بندی‌شدهٔ ماهانه** (declarative partitioning) و داشبورد از **جداول تجمیعی** ساعتی و روزانه می‌خواند (کارت ۳.۲).
- queryهایی که Prisma خوب پشتیبانی نمی‌کند (پارتیشن، upsert تجمیعی، `ON CONFLICT DO NOTHING` گروهی) با `$queryRaw` و SQL دستی در migration نوشته می‌شوند.
- مبالغ مالی مطابق قرارداد و شِمای فعلی با `Decimal(18,8)` ذخیره، در API به‌صورت رشتهٔ اعشاری دلاری و در محاسبات با BigInt fixed-point پردازش می‌شوند. عبارت میکرودلار صحیح در پیش‌نویس اولیه با قرارداد فعلی جایگزین شده است؛ محاسبهٔ float برای پول مجاز نیست.
- در production، PgBouncer جلوی Postgres قرار می‌گیرد.

## پیامدها (Consequences)

### مثبت

- یک دیتابیس برای همه‌چیز در MVP؛ backup و عملیات ساده.
- schema و تایپ‌ها از یک منبع (`schema.prisma`) تولید می‌شوند.
- pgvector روی همان Postgres برای semantic cache (کارت ۱۳.۲).

### منفی

- Prisma پارتیشن‌بندی را مدل نمی‌کند؛ بخشی از DDL دستی است و باید با `prisma migrate` هماهنگ بماند.
- Prisma client کمی overhead دارد؛ مسیرهای پرحجم worker از insert گروهی خام استفاده می‌کنند.
- با رشد لاگ (میلیون‌ها ردیف در روز) aggregation روی Postgres کند می‌شود.

### پیگیری

- اگر حجم لاگ از حدود ۵۰ میلیون ردیف در ماه گذشت، ADR جدید برای انتقال لاگ و آنالیتیکس به ClickHouse.
- گیت‌وی به `@dirouter/db` وابسته نیست (ADR-006).

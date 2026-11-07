/**
 * کارهای زمان‌بندی‌شدهٔ worker (کارت‌های ۳.۲ و ۶.۵): rollup ساعتی/روزانه، ساخت
 * پارتیشن ماه‌های آینده و retention لاگ خام.
 *
 * زمان‌بندی با job scheduler در BullMQ است: هر tick فقط یک job می‌سازد و فقط یک
 * replica آن را برمی‌دارد. خود توابع SQL هم idempotent هستند و پارتیشن‌سازی با
 * advisory lock از اجرای هم‌زمان محافظت می‌شود.
 */
import type { Logger } from '@dirouter/shared';

export const DIRTY_HOURS_KEY = 'dirouter:rollup:dirty-hours';

export interface MaintenanceDb {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $transaction<T extends unknown[]>(ops: [...{ [K in keyof T]: Promise<T[K]> }]): Promise<T>;
}

export interface DirtySet {
  sadd(key: string, ...members: string[]): Promise<number>;
  spop(key: string, count: number): Promise<string[]>;
}

const PARTITION_LOCK = 482_901; // کلید ثابت advisory lock

export async function ensurePartitions(db: MaintenanceDb, monthsAhead = 3): Promise<number> {
  const [, rows] = await db.$transaction([
    db.$queryRawUnsafe('SELECT 1 AS locked FROM pg_advisory_xact_lock($1)', PARTITION_LOCK),
    db.$queryRawUnsafe<{ n: number }[]>(
      'SELECT dirouter_ensure_request_log_partitions($1)::int AS n',
      monthsAhead,
    ),
  ]);
  return rows[0]?.n ?? 0;
}

export async function dropOldPartitions(db: MaintenanceDb, retainMonths: number): Promise<number> {
  const [, rows] = await db.$transaction([
    db.$queryRawUnsafe('SELECT 1 AS locked FROM pg_advisory_xact_lock($1)', PARTITION_LOCK),
    db.$queryRawUnsafe<{ n: number }[]>(
      'SELECT dirouter_drop_request_log_partitions($1)::int AS n',
      retainMonths,
    ),
  ]);
  return rows[0]?.n ?? 0;
}

/**
 * ساعت‌های علامت‌خورده را برمی‌دارد (SPOP اتمیک: دو replica یک ساعت را با هم نمی‌گیرند)،
 * به‌علاوهٔ ساعت جاری و قبلی برای اطمینان، و ساعت‌ها و روزهای مربوط را از نو حساب می‌کند.
 */
export async function rollup(
  db: MaintenanceDb,
  dirty: DirtySet,
  logger: Logger,
  now = new Date(),
): Promise<{ hours: number; days: number }> {
  const popped = await dirty.spop(DIRTY_HOURS_KEY, 1000);
  const current = new Date(now);
  current.setUTCMinutes(0, 0, 0);
  const previous = new Date(current.getTime() - 3_600_000);
  const hours = new Set([...popped, current.toISOString(), previous.toISOString()]);
  const days = new Set<string>();
  try {
    for (const hour of [...hours].sort()) {
      await db.$queryRawUnsafe('SELECT dirouter_rollup_hour($1::timestamptz)', hour);
      days.add(hour.slice(0, 10));
    }
    for (const day of [...days].sort()) {
      await db.$queryRawUnsafe('SELECT dirouter_rollup_day($1::date)', day);
    }
  } catch (error) {
    // ساعت‌ها برمی‌گردند تا tick بعدی دوباره امتحان کند.
    if (popped.length > 0) await dirty.sadd(DIRTY_HOURS_KEY, ...popped);
    throw error;
  }
  if (popped.length > 0) logger.debug({ hours: hours.size, days: days.size }, 'rollup done');
  return { hours: hours.size, days: days.size };
}

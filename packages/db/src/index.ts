/**
 * کلاینت Prisma و تایپ‌های دیتابیس. فقط control-api و worker از این پکیج استفاده
 * می‌کنند؛ gateway هرگز به دیتابیس وصل نمی‌شود.
 */
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../generated/client/index.js';

export * from '../generated/client/index.js';
export { Prisma } from '../generated/client/index.js';

export interface CreatePrismaOptions {
  databaseUrl: string;
  /** سقف connection pool (پیش‌فرض ۱۰). */
  maxConnections?: number;
}

export function createPrismaClient(options: CreatePrismaOptions): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: options.databaseUrl,
    max: options.maxConnections ?? 10,
  });
  return new PrismaClient({ adapter });
}

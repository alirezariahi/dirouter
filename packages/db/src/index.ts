/**
 * Prisma client and database types. Only control-api and the worker use this package;
 * the gateway never connects to the database.
 */
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../generated/client/index.js';

export * from '../generated/client/index.js';
export { Prisma } from '../generated/client/index.js';

export interface CreatePrismaOptions {
  databaseUrl: string;
  /** Connection pool limit (default 10). */
  maxConnections?: number;
}

export function createPrismaClient(options: CreatePrismaOptions): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: options.databaseUrl,
    max: options.maxConnections ?? 10,
  });
  return new PrismaClient({ adapter });
}

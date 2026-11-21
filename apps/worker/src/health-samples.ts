/**
 * Uptime history of providers (card 12.3): the gateway pushes probe samples to a Valkey list and
 * this job moves them to `provider_health_samples` in batches. Old rows are pruned by retention.
 */
import { randomUUID } from 'node:crypto';

import type { Logger } from '@dirouter/shared';
import { z } from 'zod';

/** Must match `HEALTH_SAMPLES_KEY` in the gateway. */
export const HEALTH_SAMPLES_KEY = 'dirouter:health:samples';

export const HealthSample = z.object({
  providerId: z.string().min(1),
  credentialId: z.string().min(1).optional(),
  ok: z.boolean(),
  status: z.int().optional(),
  latencyMs: z.int().nonnegative(),
  errorClass: z.string().max(64).optional(),
  checkedAt: z.iso.datetime(),
});
export type HealthSample = z.infer<typeof HealthSample>;

export interface HealthSampleDb {
  providerHealthSample: {
    createMany(args: {
      data: {
        id: string;
        providerId: string;
        credentialId: string | null;
        ok: boolean;
        status: number | null;
        latencyMs: number;
        errorClass: string | null;
        checkedAt: Date;
      }[];
    }): Promise<{ count: number }>;
    deleteMany(args: { where: { checkedAt: { lt: Date } } }): Promise<{ count: number }>;
  };
}

export interface SampleQueue {
  rpop(key: string, count: number): Promise<string[] | null>;
  rpush(key: string, ...values: string[]): Promise<number>;
}

export interface DrainOptions {
  batchSize?: number;
  maxBatches?: number;
  retentionDays?: number;
  now?: () => number;
}

/** Moves queued samples to Postgres; a failed insert puts the batch back so nothing is lost. */
export async function drainHealthSamples(
  db: HealthSampleDb,
  queue: SampleQueue,
  logger: Logger,
  options: DrainOptions = {},
): Promise<{ written: number; invalid: number; pruned: number }> {
  const batchSize = options.batchSize ?? 500;
  const maxBatches = options.maxBatches ?? 20;
  const now = options.now ?? Date.now;
  let written = 0;
  let invalid = 0;
  for (let i = 0; i < maxBatches; i++) {
    const raw = await queue.rpop(HEALTH_SAMPLES_KEY, batchSize);
    if (!raw || raw.length === 0) break;
    const rows = [];
    for (const item of raw) {
      let parsed;
      try {
        parsed = HealthSample.safeParse(JSON.parse(item));
      } catch {
        parsed = undefined;
      }
      if (!parsed?.success) {
        invalid++;
        continue;
      }
      const s = parsed.data;
      rows.push({
        id: randomUUID(),
        providerId: s.providerId,
        credentialId: s.credentialId ?? null,
        ok: s.ok,
        status: s.status ?? null,
        latencyMs: s.latencyMs,
        errorClass: s.errorClass ?? null,
        checkedAt: new Date(s.checkedAt),
      });
    }
    if (rows.length > 0) {
      try {
        const result = await db.providerHealthSample.createMany({ data: rows });
        written += result.count;
      } catch (error) {
        // Put the batch back at the consuming end so order is kept and the next run retries.
        await queue.rpush(HEALTH_SAMPLES_KEY, ...[...raw].reverse()).catch(() => undefined);
        logger.warn({ err: error, batch: raw.length }, 'health samples insert failed; requeued');
        throw error;
      }
    }
    if (raw.length < batchSize) break;
  }
  const retentionDays = options.retentionDays ?? 30;
  const pruned = (
    await db.providerHealthSample.deleteMany({
      where: { checkedAt: { lt: new Date(now() - retentionDays * 86_400_000) } },
    })
  ).count;
  if (invalid > 0) logger.warn({ invalid }, 'dropped malformed health samples');
  return { written, invalid, pruned };
}

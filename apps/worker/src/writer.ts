/**
 * Batch-writes usage events to request_log and usage_ledger (card 6.4).
 *
 * Each queue job is one event; the writer collects them and writes with createMany and
 * skipDuplicates (ON CONFLICT DO NOTHING) . Each job's promise resolves after the commit
 * of its batch, so BullMQ only completes events that were written.
 * If a batch fails, events are written one by one so a bad event does not hold back the rest.
 */
import type { UsageEvent } from '@dirouter/contracts';
import { type Logger, prefixedId } from '@dirouter/shared';

export interface UsageDb {
  $transaction(ops: Promise<unknown>[]): Promise<unknown>;
  /** Present on Prisma; records the end users a batch named (card 33.2). */
  $executeRawUnsafe?(query: string, ...values: unknown[]): Promise<number>;
  requestLog: { createMany(args: { data: unknown[]; skipDuplicates: boolean }): Promise<unknown> };
  usageLedger: { createMany(args: { data: unknown[]; skipDuplicates: boolean }): Promise<unknown> };
}

export interface WriterOptions {
  db: UsageDb;
  logger: Logger;
  batchSize: number;
  flushMs: number;
  /** Called after each commit with the changed hours (ISO, start of the UTC hour). */
  onWritten?: (hours: Set<string>, count: number) => Promise<void> | void;
}

interface Pending {
  event: UsageEvent;
  resolve: () => void;
  reject: (error: unknown) => void;
}

export function toRequestLogRow(e: UsageEvent) {
  return {
    id: e.requestId,
    createdAt: new Date(e.occurredAt),
    organizationId: e.organizationId,
    teamId: e.teamId,
    projectId: e.projectId,
    apiKeyId: e.virtualKeyId,
    endUser: e.endUser ?? null,
    inboundApi: e.inboundApi,
    requestedModel: e.requestedModel,
    modelId: e.resolvedModelId,
    providerId: e.providerId,
    credentialId: e.credentialId,
    stream: e.stream,
    status: e.status,
    httpStatus: e.httpStatus,
    errorCode: e.errorCode ?? null,
    inputTokens: e.usage.inputTokens,
    outputTokens: e.usage.outputTokens,
    cacheReadTokens: e.usage.cacheReadTokens,
    cacheWriteTokens: e.usage.cacheWriteTokens,
    reasoningTokens: e.usage.reasoningTokens,
    costUsd: e.costUsd,
    chargeUsd: e.chargeUsd ?? e.costUsd,
    usageEstimated: e.usageEstimated,
    latencyMs: e.latencyMs,
    ttftMs: e.ttftMs ?? null,
    attempts: e.attempts,
    configVersion: e.configVersion,
    gatewayInstance: e.gatewayInstance,
    cacheHit: e.cacheHit ?? false,
    cacheKind: e.cacheKind ?? null,
    savedInputTokens: e.savedInputTokens ?? 0,
    hedgeAttempts: e.hedgeAttempts ?? 0,
    tags: e.tags ?? [],
    costCenter: e.costCenter ?? null,
    ...(e.routing ? { routing: e.routing } : {}),
    ...(e.media ? { media: e.media } : {}),
    ...(e.policy ? { policy: e.policy } : {}),
    // The routing decision (cards 32.5 and 32.7): data policy, removed targets and more.
    ...(e.routeDecision ? { routeDecision: e.routeDecision } : {}),
    // The service tier the request was priced at (card 31.5).
    ...(e.serviceTier ? { serviceTier: e.serviceTier } : {}),
  };
}

export function toLedgerRow(e: UsageEvent) {
  return {
    id: e.eventId,
    requestId: e.idempotencyKey,
    organizationId: e.organizationId,
    teamId: e.teamId,
    projectId: e.projectId,
    apiKeyId: e.virtualKeyId,
    modelId: e.resolvedModelId,
    providerId: e.providerId,
    endUser: e.endUser ?? null,
    requestedModel: e.requestedModel,
    tags: e.tags ?? [],
    costCenter: e.costCenter ?? null,
    costUsd: e.costUsd,
    tokens: e.usage.inputTokens + e.usage.outputTokens,
    occurredAt: new Date(e.occurredAt),
  };
}

/**
 * End users a batch named (card 33.2): created on first sight, with the first and last time seen.
 * One statement per batch, in the same transaction as the usage rows.
 */
export const END_USERS_UPSERT = `
INSERT INTO end_users (id, organization_id, external_id, first_seen_at, last_seen_at, updated_at)
SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::timestamptz[], $5::timestamptz[],
                     $5::timestamptz[])
ON CONFLICT (organization_id, external_id) DO UPDATE SET
  first_seen_at = LEAST(coalesce(end_users.first_seen_at, EXCLUDED.first_seen_at),
                        EXCLUDED.first_seen_at),
  last_seen_at = GREATEST(coalesce(end_users.last_seen_at, EXCLUDED.last_seen_at),
                          EXCLUDED.last_seen_at),
  updated_at = now()`;

export function endUsersOf(events: UsageEvent[]) {
  const seen = new Map<string, { org: string; id: string; first: number; last: number }>();
  for (const e of events) {
    if (!e.endUser) continue;
    const at = Date.parse(e.occurredAt);
    const key = `${e.organizationId}\u0000${e.endUser}`;
    const row = seen.get(key);
    if (row) {
      row.first = Math.min(row.first, at);
      row.last = Math.max(row.last, at);
    } else seen.set(key, { org: e.organizationId, id: e.endUser, first: at, last: at });
  }
  return [...seen.values()];
}

export const hourOf = (iso: string) => {
  const d = new Date(iso);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
};

export class UsageBatchWriter {
  readonly #opts: WriterOptions;
  #buffer: Pending[] = [];
  #timer: NodeJS.Timeout | undefined;
  #inflight = new Set<Promise<void>>();
  written = 0;
  batches = 0;
  failures = 0;

  constructor(opts: WriterOptions) {
    this.#opts = opts;
  }

  add(event: UsageEvent): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.#buffer.push({ event, resolve, reject });
      if (this.#buffer.length >= this.#opts.batchSize) this.#flushNow();
      else
        this.#timer ??= setTimeout(() => {
          this.#flushNow();
        }, this.#opts.flushMs);
    });
  }

  /** Flushes the entire buffer and waits for in-progress batches (for shutdown). */
  async drain(): Promise<void> {
    this.#flushNow();
    await Promise.allSettled([...this.#inflight]);
  }

  #flushNow(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#buffer.length === 0) return;
    const batch = this.#buffer.splice(0);
    const p = this.#write(batch).finally(() => this.#inflight.delete(p));
    this.#inflight.add(p);
  }

  async #insert(events: UsageEvent[]): Promise<void> {
    const { db } = this.#opts;
    const endUsers = endUsersOf(events);
    await db.$transaction([
      db.requestLog.createMany({ data: events.map(toRequestLogRow), skipDuplicates: true }),
      db.usageLedger.createMany({ data: events.map(toLedgerRow), skipDuplicates: true }),
      ...(endUsers.length > 0 && db.$executeRawUnsafe
        ? [
            db.$executeRawUnsafe(
              END_USERS_UPSERT,
              endUsers.map(() => prefixedId('eu')),
              endUsers.map((u) => u.org),
              endUsers.map((u) => u.id),
              endUsers.map((u) => new Date(u.first)),
              endUsers.map((u) => new Date(u.last)),
            ),
          ]
        : []),
    ]);
  }

  async #write(batch: Pending[]): Promise<void> {
    const done: Pending[] = [];
    try {
      await this.#insert(batch.map((p) => p.event));
      done.push(...batch);
      this.batches++;
    } catch (error) {
      if (batch.length === 1) {
        this.failures++;
        batch[0]?.reject(error);
        return;
      }
      this.#opts.logger.warn(
        { err: error, events: batch.length },
        'usage batch failed, writing one by one',
      );
      for (const p of batch) {
        try {
          await this.#insert([p.event]);
          done.push(p);
        } catch (err) {
          this.failures++;
          p.reject(err);
        }
      }
    }
    if (done.length === 0) return;
    this.written += done.length;
    try {
      await this.#opts.onWritten?.(
        new Set(done.map((p) => hourOf(p.event.occurredAt))),
        done.length,
      );
    } catch (error) {
      // if the rollup mark is lost, the periodic rollup also recomputes the current and previous hour.
      this.#opts.logger.warn({ err: error }, 'failed to mark rollup hours');
    }
    for (const p of done) p.resolve();
  }
}

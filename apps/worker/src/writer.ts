/**
 * نوشتن دسته‌ای رویدادهای مصرف در request_log و usage_ledger (کارت ۶.۴).
 *
 * هر job صف یک رویداد است؛ writer آن‌ها را جمع می‌کند و با createMany و
 * skipDuplicates (ON CONFLICT DO NOTHING) می‌نویسد. promise هر job بعد از commit
 * دسته resolve می‌شود، پس BullMQ فقط رویداد نوشته‌شده را complete می‌کند.
 * اگر دسته شکست بخورد، رویدادها تک‌تک نوشته می‌شوند تا رویداد خراب بقیه را نگه ندارد.
 */
import type { UsageEvent } from '@dirouter/contracts';
import type { Logger } from '@dirouter/shared';

export interface UsageDb {
  $transaction(ops: Promise<unknown>[]): Promise<unknown>;
  requestLog: { createMany(args: { data: unknown[]; skipDuplicates: boolean }): Promise<unknown> };
  usageLedger: { createMany(args: { data: unknown[]; skipDuplicates: boolean }): Promise<unknown> };
}

export interface WriterOptions {
  db: UsageDb;
  logger: Logger;
  batchSize: number;
  flushMs: number;
  /** بعد از هر commit با ساعت‌های تغییرکرده (ISO، ابتدای ساعت UTC) صدا زده می‌شود. */
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
    usageEstimated: e.usageEstimated,
    latencyMs: e.latencyMs,
    ttftMs: e.ttftMs ?? null,
    attempts: e.attempts,
    configVersion: e.configVersion,
    gatewayInstance: e.gatewayInstance,
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
    costUsd: e.costUsd,
    tokens: e.usage.inputTokens + e.usage.outputTokens,
    occurredAt: new Date(e.occurredAt),
  };
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

  /** نوشتن همهٔ بافر و انتظار برای دسته‌های در حال نوشتن (برای shutdown). */
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
    await db.$transaction([
      db.requestLog.createMany({ data: events.map(toRequestLogRow), skipDuplicates: true }),
      db.usageLedger.createMany({ data: events.map(toLedgerRow), skipDuplicates: true }),
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
      // علامت rollup از دست برود، rollup دوره‌ای ساعت جاری و قبلی را هم حساب می‌کند.
      this.#opts.logger.warn({ err: error }, 'failed to mark rollup hours');
    }
    for (const p of done) p.resolve();
  }
}

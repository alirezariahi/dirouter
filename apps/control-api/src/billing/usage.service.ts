/**
 * A customer's own usage for the portal (card 26.2): cost and tokens by day, model and key, and the
 * latest requests with what each one cost.
 *
 * The cost is what the customer paid, from the same rows its other billing pages show, so the
 * figures agree to the last unit:
 * - prepaid organizations: the `usage` debits of their wallet (the wallet statement's usage lines),
 *   per request; a request paid entirely from a plan's allowance takes nothing from the wallet and
 *   is not listed;
 * - postpaid organizations: the sale price of each request in the request log (what the monthly
 *   invoice bills, through the daily rollup).
 * Tokens come from the request log. Every query is filtered by the organization (and its wallet),
 * which the route's OrgGuard has already checked the caller belongs to.
 */
import { fromUnits, toUnits } from '@dirouter/db';
import { DiRouterError } from '@dirouter/shared';
import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from '../infra/prisma.service.js';

const DAY = 86_400_000;
/** The longest range one call may cover. */
export const MAX_USAGE_DAYS = 93;
const RECENT = 50;

interface Row {
  at: Date;
  requestId: string;
  model: string;
  apiKeyId: string | null;
  cost: string;
  input: number | null;
  output: number | null;
}

interface Bucket {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cost: bigint;
}

const empty = (): Bucket => ({ requests: 0, inputTokens: 0, outputTokens: 0, cost: 0n });
const view = (b: Bucket) => ({
  requests: b.requests,
  inputTokens: b.inputTokens,
  outputTokens: b.outputTokens,
  costUsd: fromUnits(b.cost),
});

@Injectable()
export class UsageService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  get db() {
    return this.prisma.client;
  }

  /** Usage of [from, to) (UTC days); defaults to the last 30 days including today. */
  async usage(organizationId: string, from?: string, to?: string, now = new Date()) {
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const end = to ? new Date(`${to}T00:00:00Z`) : new Date(today + DAY);
    const start = from ? new Date(`${from}T00:00:00Z`) : new Date(end.getTime() - 30 * DAY);
    if (!(start < end))
      throw new DiRouterError('validation_failed', { message: 'from must be before to' });
    if (end.getTime() - start.getTime() > MAX_USAGE_DAYS * DAY)
      throw new DiRouterError('validation_failed', {
        message: `a range covers at most ${String(MAX_USAGE_DAYS)} days`,
      });

    const wallet = await this.db.wallet.findUnique({
      where: { organizationId },
      select: { id: true },
    });
    // Log rows of a charge can be a little older than the charge itself (the worker posts later).
    const logFrom = new Date(start.getTime() - DAY);
    const logTo = new Date(end.getTime() + DAY);
    const rows = wallet
      ? await this.db.$queryRaw<Row[]>`
          SELECT e."created_at" AS "at", t."metadata"->>'requestId' AS "requestId",
                 COALESCE(m."slug", r."requested_model", t."metadata"->>'model', r."model_id", 'unknown') AS "model",
                 COALESCE(t."metadata"->>'apiKeyId', r."api_key_id") AS "apiKeyId",
                 (-e."amount_usd")::text AS "cost",
                 r."input_tokens" AS "input", r."output_tokens" AS "output"
            FROM "wallet_entries" e
            JOIN "wallet_transactions" t ON t."id" = e."transaction_id"
            LEFT JOIN "request_log" r ON r."id" = t."metadata"->>'requestId'
                 AND r."organization_id" = ${organizationId}
                 AND r."created_at" >= ${logFrom} AND r."created_at" < ${logTo}
            -- The customer sees the model's name, not its internal id.
            LEFT JOIN "models" m ON m."id" = COALESCE(t."metadata"->>'model', r."model_id")
                 AND m."organization_id" = ${organizationId}
           WHERE e."wallet_id" = ${wallet.id} AND t."kind" = 'usage'
             AND e."created_at" >= ${start} AND e."created_at" < ${end}
           ORDER BY e."created_at" DESC, e."id" DESC`
      : await this.db.$queryRaw<Row[]>`
          SELECT r."created_at" AS "at", r."id" AS "requestId",
                 COALESCE(m."slug", r."requested_model", r."model_id") AS "model", r."api_key_id" AS "apiKeyId",
                 r."charge_usd"::text AS "cost", r."input_tokens" AS "input", r."output_tokens" AS "output"
            FROM "request_log" r
            LEFT JOIN "models" m ON m."id" = r."model_id" AND m."organization_id" = ${organizationId}
           WHERE r."organization_id" = ${organizationId}
             AND r."created_at" >= ${start} AND r."created_at" < ${end}
           ORDER BY r."created_at" DESC, r."id" DESC`;

    const total = empty();
    const byDay = new Map<string, Bucket>();
    const byModel = new Map<string, Bucket>();
    const byKey = new Map<string, Bucket>();
    const add = (map: Map<string, Bucket>, key: string, row: Row, cost: bigint) => {
      const b = map.get(key) ?? empty();
      b.requests++;
      b.inputTokens += row.input ?? 0;
      b.outputTokens += row.output ?? 0;
      b.cost += cost;
      map.set(key, b);
    };
    for (const row of rows) {
      const cost = toUnits(row.cost);
      total.requests++;
      total.inputTokens += row.input ?? 0;
      total.outputTokens += row.output ?? 0;
      total.cost += cost;
      add(byDay, row.at.toISOString().slice(0, 10), row, cost);
      add(byModel, row.model, row, cost);
      add(byKey, row.apiKeyId ?? '', row, cost);
    }

    const keyIds = [...byKey.keys()].filter((k) => k !== '');
    const keys = await this.db.apiKey.findMany({
      where: { organizationId, id: { in: keyIds } },
      select: { id: true, name: true, prefix: true },
    });
    const keyInfo = new Map(keys.map((k) => [k.id, k]));
    const days: {
      day: string;
      requests: number;
      inputTokens: number;
      outputTokens: number;
      costUsd: string;
    }[] = [];
    for (let t = start.getTime(); t < end.getTime(); t += DAY) {
      const day = new Date(t).toISOString().slice(0, 10);
      days.push({ day, ...view(byDay.get(day) ?? empty()) });
    }
    const byCost = <T extends { costUsd: string; requests: number }>(a: T, b: T) => {
      const d = toUnits(b.costUsd) - toUnits(a.costUsd);
      return d > 0n ? 1 : d < 0n ? -1 : b.requests - a.requests;
    };
    return {
      from: start.toISOString().slice(0, 10),
      to: end.toISOString().slice(0, 10),
      basis: wallet ? ('prepaid' as const) : ('postpaid' as const),
      totals: view(total),
      byDay: days,
      byModel: [...byModel.entries()].map(([model, b]) => ({ model, ...view(b) })).sort(byCost),
      byKey: [...byKey.entries()]
        .map(([id, b]) => ({
          apiKeyId: id || null,
          name: keyInfo.get(id)?.name ?? null,
          prefix: keyInfo.get(id)?.prefix ?? null,
          ...view(b),
        }))
        .sort(byCost),
      recent: rows.slice(0, RECENT).map((r) => ({
        requestId: r.requestId,
        createdAt: r.at.toISOString(),
        model: r.model,
        apiKeyId: r.apiKeyId,
        keyName: keyInfo.get(r.apiKeyId ?? '')?.name ?? null,
        inputTokens: r.input,
        outputTokens: r.output,
        costUsd: fromUnits(toUnits(r.cost)),
      })),
    };
  }
}

/**
 * Upstream balances (card 32.9): the gateway pushes one balance sample per credential to a Valkey
 * list; this job keeps the newest one per credential in `credential_balances`, which the
 * Providers page and the `upstream_balance_low` alert rule read.
 */
import { UPSTREAM_BALANCES_KEY, UpstreamBalanceSample } from '@dirouter/contracts';
import type { Logger } from '@dirouter/shared';

export interface BalanceRow {
  credentialId: string;
  providerId: string;
  kind: string;
  ok: boolean;
  amount: string | null;
  currency: string | null;
  error: string | null;
  checkedAt: Date;
}

export interface BalanceDb {
  credential: {
    findMany(args: {
      where: { id: { in: string[] } };
      select: { id: true };
    }): Promise<{ id: string }[]>;
  };
  credentialBalance: {
    upsert(args: {
      where: { credentialId: string };
      create: BalanceRow;
      update: Partial<Omit<BalanceRow, 'credentialId'>>;
    }): Promise<unknown>;
  };
}

export interface BalanceQueue {
  rpop(key: string, count: number): Promise<string[] | null>;
}

/**
 * The row to store for a sample. A failed lookup keeps the last known amount (only `ok`, `error`
 * and the time change), so a provider outage does not look like an empty account.
 */
export function balanceRow(sample: UpstreamBalanceSample): BalanceRow {
  return {
    credentialId: sample.credentialId,
    providerId: sample.providerId,
    kind: sample.kind,
    ok: sample.ok,
    amount: sample.ok ? (sample.amount ?? null) : null,
    currency: sample.ok ? (sample.currency ?? null) : null,
    error: sample.ok ? null : (sample.error ?? 'lookup failed'),
    checkedAt: new Date(sample.checkedAt),
  };
}

/** Stores one sample (also used by the control-api's refresh through the same rules). */
export async function saveBalance(db: BalanceDb, sample: UpstreamBalanceSample): Promise<void> {
  const { credentialId, ...rest } = balanceRow(sample);
  await db.credentialBalance.upsert({
    where: { credentialId },
    create: { credentialId, ...rest },
    update: rest.ok
      ? rest
      : {
          providerId: rest.providerId,
          kind: rest.kind,
          ok: false,
          error: rest.error,
          checkedAt: rest.checkedAt,
        },
  });
}

export async function drainBalances(
  db: BalanceDb,
  queue: BalanceQueue,
  logger: Logger,
  batchSize = 500,
): Promise<{ written: number; invalid: number; skipped: number }> {
  const raw = (await queue.rpop(UPSTREAM_BALANCES_KEY, batchSize)) ?? [];
  // The list is pushed on the left and popped on the right: oldest first, so the newest sample
  // of a credential is written last and wins.
  const samples: UpstreamBalanceSample[] = [];
  let invalid = 0;
  for (const item of raw) {
    let parsed;
    try {
      parsed = UpstreamBalanceSample.safeParse(JSON.parse(item));
    } catch {
      parsed = undefined;
    }
    if (parsed?.success) samples.push(parsed.data);
    else invalid++;
  }
  if (samples.length === 0) return { written: 0, invalid, skipped: 0 };
  // A credential deleted since the lookup has nowhere to keep its balance.
  const alive = new Set(
    (
      await db.credential.findMany({
        where: { id: { in: [...new Set(samples.map((s) => s.credentialId))] } },
        select: { id: true },
      })
    ).map((c) => c.id),
  );
  let written = 0;
  let skipped = 0;
  for (const sample of samples) {
    if (!alive.has(sample.credentialId)) {
      skipped++;
      continue;
    }
    await saveBalance(db, sample);
    written++;
  }
  if (invalid > 0) logger.warn({ invalid }, 'dropped malformed balance samples');
  return { written, invalid, skipped };
}

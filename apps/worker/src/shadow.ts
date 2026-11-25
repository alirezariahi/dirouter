/**
 * Shadow copies (card 32.4) arrive on the usage queue like any usage event, with `shadow` set.
 * They are stored in `shadow_requests` only: never in the request log, the ledger, the hourly and
 * daily rollups or a wallet, so a shadow experiment costs the customer nothing and shows up only
 * in its own report.
 */
import type { UsageEvent } from '@dirouter/contracts';

export interface ShadowDb {
  shadowRequest: {
    createMany(args: { data: unknown[]; skipDuplicates: boolean }): Promise<{ count: number }>;
  };
}

export function toShadowRow(e: UsageEvent & { shadow: NonNullable<UsageEvent['shadow']> }) {
  return {
    id: e.requestId,
    createdAt: new Date(e.occurredAt),
    organizationId: e.organizationId,
    policyId: e.shadow.policyId,
    projectId: e.projectId,
    apiKeyId: e.virtualKeyId,
    primaryRequestId: e.shadow.primaryRequestId,
    modelId: e.resolvedModelId,
    status: e.status,
    httpStatus: e.httpStatus,
    errorCode: e.errorCode ?? null,
    inputTokens: e.usage.inputTokens,
    outputTokens: e.usage.outputTokens,
    costUsd: e.costUsd,
    latencyMs: e.latencyMs,
    primaryModel: e.shadow.primaryModel,
    primaryStatus: e.shadow.primaryStatus,
    primaryLatencyMs: e.shadow.primaryLatencyMs,
    primaryCostUsd: e.shadow.primaryCostUsd,
  };
}

/** Idempotent by the shadow request id; returns false for an event that is not a shadow copy. */
export async function writeShadow(db: ShadowDb, e: UsageEvent): Promise<boolean> {
  if (!e.shadow) return false;
  await db.shadowRequest.createMany({
    data: [toShadowRow({ ...e, shadow: e.shadow })],
    skipDuplicates: true,
  });
  return true;
}

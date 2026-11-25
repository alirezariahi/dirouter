/**
 * Live view events (card 24.4): the gateway publishes one small event per finished request on the
 * Valkey channel of its organization; control-api streams them to the dashboard over SSE.
 *
 * Metadata only, the same fields the Live page already showed from polling: never a prompt, an
 * answer, an end user or a credential.
 */
import { z } from 'zod';

import { IsoDateTime } from './common.js';
import type { UsageEvent } from './usage-event.js';

/** Valkey pub/sub channel of one organization's request events. */
export const liveChannel = (organizationId: string) => `dirouter:live:${organizationId}`;

export const LiveRequestEvent = z.object({
  id: z.string(),
  createdAt: IsoDateTime,
  projectId: z.string(),
  apiKeyId: z.string(),
  requestedModel: z.string(),
  modelId: z.string().nullable(),
  providerId: z.string().nullable(),
  stream: z.boolean(),
  status: z.string(),
  httpStatus: z.int(),
  errorCode: z.string().nullable(),
  inputTokens: z.int(),
  outputTokens: z.int(),
  costUsd: z.string(),
  latencyMs: z.int(),
  ttftMs: z.int().nullable(),
});
export type LiveRequestEvent = z.infer<typeof LiveRequestEvent>;

/** The live view of a usage event, shaped like a request log row. */
export function toLiveEvent(event: UsageEvent): LiveRequestEvent {
  return {
    id: event.requestId,
    createdAt: event.occurredAt,
    projectId: event.projectId,
    apiKeyId: event.virtualKeyId,
    requestedModel: event.requestedModel,
    modelId: event.resolvedModelId,
    providerId: event.providerId,
    stream: event.stream,
    status: event.status,
    httpStatus: event.httpStatus,
    errorCode: event.errorCode ?? null,
    inputTokens: event.usage.inputTokens,
    outputTokens: event.usage.outputTokens,
    costUsd: event.costUsd,
    latencyMs: event.latencyMs,
    ttftMs: event.ttftMs ?? null,
  };
}

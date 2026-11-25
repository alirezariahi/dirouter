/**
 * Request and answer shaping around the provider call (sprint 5, epic 31). The logic lives in
 * `@dirouter/translator`; this module decides what applies to a request and reports it.
 *
 * - Repair (card 31.1): the key's `repair` list, or the `x-dirouter-repair` header, enables JSON
 *   repair of non-streamed `response_format` answers and tool-call repair of the history and of
 *   answers. Each applied repair is logged and counted in `dirouter_gateway_repairs_total`.
 */
import type {
  CanonicalRequest,
  CanonicalResponse,
  RepairKind,
  VirtualKeyConfig,
} from '@dirouter/contracts';
import type { Logger } from '@dirouter/shared';
import {
  parseRepairHeader,
  type RepairAction,
  repairResponse,
  repairToolHistory,
} from '@dirouter/translator';

import type { GatewayMetrics } from './metrics.js';

export const REPAIR_HEADER = 'x-dirouter-repair';

export interface ShapingDeps {
  logger: Logger;
  metrics?: GatewayMetrics | undefined;
}

/** Repairs for this request: the header when present, else the key's setting. */
export function repairKindsFor(
  headers: Record<string, string | string[] | undefined>,
  key: Pick<VirtualKeyConfig, 'repair'>,
): RepairKind[] {
  const header = headers[REPAIR_HEADER];
  return parseRepairHeader(typeof header === 'string' ? header : undefined) ?? key.repair;
}

function report(
  deps: ShapingDeps,
  requestId: string,
  stage: 'request' | 'response',
  actions: RepairAction[],
): void {
  if (actions.length === 0) return;
  for (const action of actions) deps.metrics?.repair(action);
  deps.logger.info({ requestId, stage, repairs: actions }, 'repaired before passing on');
}

/** Tool-history repair, once per request before routing. */
export function repairRequest(
  request: CanonicalRequest,
  kinds: readonly RepairKind[],
  deps: ShapingDeps,
  requestId: string,
): CanonicalRequest {
  if (!kinds.includes('tools')) return request;
  const { request: repaired, actions } = repairToolHistory(request);
  report(deps, requestId, 'request', actions);
  return repaired;
}

/** JSON and tool-argument repair of a non-streamed answer. */
export function repairAnswer(
  response: CanonicalResponse,
  request: CanonicalRequest,
  kinds: readonly RepairKind[],
  deps: ShapingDeps,
  requestId: string,
): CanonicalResponse {
  if (kinds.length === 0 || request.stream) return response;
  const { response: repaired, actions } = repairResponse(response, request, kinds);
  report(deps, requestId, 'response', actions);
  return repaired;
}

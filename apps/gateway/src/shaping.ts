/**
 * Request and answer shaping around the provider call (sprint 5, epic 31). The logic lives in
 * `@dirouter/translator`; this module decides what applies to a request and reports it.
 *
 * - Repair (card 31.1): the key's `repair` list, or the `x-dirouter-repair` header, enables JSON
 *   repair of non-streamed `response_format` answers and tool-call repair of the history and of
 *   answers. Each applied repair is logged and counted in `dirouter_gateway_repairs_total`.
 * - Request policy per model and alias (`requestPolicy`): automatic prompt-cache breakpoints for
 *   providers with explicit caching (card 31.3).
 */
import type {
  CanonicalRequest,
  CanonicalResponse,
  ConfigSnapshot,
  ModelConfig,
  ProviderConfig,
  RepairKind,
  RequestPolicy,
  VirtualKeyConfig,
} from '@dirouter/contracts';
import type { Logger } from '@dirouter/shared';
import {
  injectCacheBreakpoints,
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

// ───────────── request policy per model and alias ─────────────

/** Provider types whose prompt cache only covers what a breakpoint marks (card 31.3). */
const EXPLICIT_CACHE_PROVIDERS: ReadonlySet<ProviderConfig['type']> = new Set([
  'anthropic',
  'bedrock',
]);

/**
 * The policy of the alias the client named, if the name is an alias of the key's organization
 * (or of the platform organization, whose public names customers may use).
 */
export function aliasPolicyFor(
  snapshot: Pick<ConfigSnapshot, 'aliases' | 'platformOrganizationId'>,
  key: Pick<VirtualKeyConfig, 'organizationId'>,
  requested: string,
): RequestPolicy | undefined {
  const own = snapshot.aliases.find(
    (a) => a.slug === requested && a.organizationId === key.organizationId,
  );
  const alias =
    own ??
    snapshot.aliases.find(
      (a) => a.slug === requested && a.organizationId === snapshot.platformOrganizationId,
    );
  return alias?.requestPolicy;
}

/** The model's policy with the alias's settings on top. */
export function effectivePolicy(
  model: Pick<ModelConfig, 'requestPolicy'>,
  alias: RequestPolicy | undefined,
): RequestPolicy {
  return { ...model.requestPolicy, ...alias };
}

/**
 * The request as one candidate receives it: the canonical request shaped by the effective policy
 * of the candidate's model (and of the alias the client named).
 */
export function shapeForCandidate(
  request: CanonicalRequest,
  candidate: { model: ModelConfig; provider: ProviderConfig },
  alias: RequestPolicy | undefined,
  deps: ShapingDeps,
  requestId: string,
): CanonicalRequest {
  const policy = effectivePolicy(candidate.model, alias);
  let shaped = request;
  if (policy.autoCache && EXPLICIT_CACHE_PROVIDERS.has(candidate.provider.type)) {
    const injected = injectCacheBreakpoints(shaped, policy.autoCacheTtl);
    if (injected.breakpoints.length > 0) {
      shaped = injected.request;
      deps.logger.debug(
        { requestId, model: candidate.model.slug, breakpoints: injected.breakpoints },
        'prompt-cache breakpoints added',
      );
    }
  }
  return shaped;
}

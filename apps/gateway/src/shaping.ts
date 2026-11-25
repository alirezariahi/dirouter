/**
 * Request and answer shaping around the provider call (sprint 5, epic 31). The logic lives in
 * `@dirouter/translator`; this module decides what applies to a request and reports it.
 *
 * - Repair (card 31.1): the key's `repair` list, or the `x-dirouter-repair` header, enables JSON
 *   repair of non-streamed `response_format` answers and tool-call repair of the history and of
 *   answers. Each applied repair is logged and counted in `dirouter_gateway_repairs_total`.
 * - Request policy per model and alias (`requestPolicy`): automatic prompt-cache breakpoints for
 *   providers with explicit caching (card 31.3), parameter defaults, overrides and removals
 *   (card 31.4).
 * - `drop_params` (card 31.4): the organization's setting, the `x-dirouter-drop-params` header or
 *   the body's `drop_params` decide whether a parameter the target cannot take is dropped (the
 *   default) or answered with a 400 that names it.
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
  applyParamPolicy,
  type DropReporter,
  guardParameterDrops,
  injectCacheBreakpoints,
  type ParamsApplied,
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

export const DROP_PARAMS_HEADER = 'x-dirouter-drop-params';
/** Response header listing what a parameter policy did (card 31.4). */
export const PARAMS_HEADER = 'x-dirouter-params';

const asBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  return v === 'true' || v === '1' ? true : v === 'false' || v === '0' ? false : undefined;
};

/**
 * `drop_params` for a request: the header, then the body's own `drop_params`, then the key's
 * organization; on (drop) when nothing says otherwise.
 */
export function dropParamsFor(
  headers: Record<string, string | string[] | undefined>,
  body: unknown,
  key: Pick<VirtualKeyConfig, 'dropParams'>,
): boolean {
  const fromBody =
    body && typeof body === 'object' ? (body as { drop_params?: unknown }).drop_params : undefined;
  return asBoolean(headers[DROP_PARAMS_HEADER]) ?? asBoolean(fromBody) ?? key.dropParams ?? true;
}

/** The body's `drop_params` is DiRouter's, not the provider's: it never travels upstream. */
export function withoutDropParams(request: CanonicalRequest): CanonicalRequest {
  if (!request.passthrough || !('drop_params' in request.passthrough)) return request;
  const { drop_params: _ours, ...passthrough } = request.passthrough;
  if (Object.keys(passthrough).length > 0) return { ...request, passthrough };
  const { passthrough: _empty, ...rest } = request;
  return rest;
}

/** What the parameter policy did, as the `x-dirouter-params` header value. */
function paramsHeader(applied: ParamsApplied): string | undefined {
  const parts = [
    ...applied.overrides.map((name) => `${name}=override`),
    ...applied.defaults.map((name) => `${name}=default`),
    ...applied.dropped.map((name) => `${name}=dropped`),
  ];
  return parts.length > 0 ? parts.join(', ') : undefined;
}

/**
 * The drop reporter of one attempt: logs at debug level and, with `drop_params` off, refuses a
 * parameter the target cannot take (a 400 naming it).
 */
export function dropReporterFor(
  candidate: { model: ModelConfig; provider: ProviderConfig },
  dropParams: boolean,
  deps: ShapingDeps,
  requestId: string,
): DropReporter {
  return guardParameterDrops(
    (field, reason) => {
      deps.logger.debug({ requestId, field, reason }, 'field dropped for provider');
    },
    { dropParams, target: `model '${candidate.model.slug}'` },
  );
}

export interface ShapedRequest {
  request: CanonicalRequest;
  /** `x-dirouter-params` value when a parameter policy changed something. */
  paramsHeader?: string;
}

/**
 * The request as one candidate receives it: the canonical request shaped by the effective policy
 * of the candidate's model (and of the alias the client named). Throws
 * `UnsupportedParameterError` (a 400) for a parameter the model does not take while `drop_params`
 * is off.
 */
export function shapeForCandidate(
  request: CanonicalRequest,
  candidate: { model: ModelConfig; provider: ProviderConfig },
  alias: RequestPolicy | undefined,
  deps: ShapingDeps,
  requestId: string,
  dropParams = true,
): ShapedRequest {
  const policy = effectivePolicy(candidate.model, alias);
  let shaped = request;
  let header: string | undefined;
  if (policy.defaults || policy.overrides || policy.drop || policy.unsupported) {
    const result = applyParamPolicy(shaped, policy, {
      dropParams,
      target: `model '${candidate.model.slug}'`,
    });
    shaped = result.request;
    header = paramsHeader(result.applied);
    if (header !== undefined)
      deps.logger.info(
        { requestId, model: candidate.model.slug, params: result.applied },
        'request parameters set by the model policy',
      );
  }
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
  return header === undefined ? { request: shaped } : { request: shaped, paramsHeader: header };
}

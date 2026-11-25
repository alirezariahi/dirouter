/**
 * The routing fields of a request (card 32.1): OpenRouter's `provider` object and `models`
 * fallback array, merged with the administrator's routing policy for the key. Shared by live
 * traffic and the routing simulator so both plan the same route.
 */
import {
  type CanonicalRequest,
  preferencesFromRequest,
  type ProviderPreferences,
  ProviderRequestObject,
  type RoutingPolicyRule,
  type VirtualKeyConfig,
} from '@dirouter/contracts';
import {
  type EffectivePolicy,
  effectivePolicy,
  MAX_FALLBACK_MODELS,
  mergePreferences,
  type PlanError,
} from '@dirouter/routing';
import { DiRouterError, ForbiddenError, NotFoundError, UpstreamError } from '@dirouter/shared';

/** Request fields that steer routing and are never sent to a provider. */
export const ROUTING_FIELDS = ['provider', 'models', 'route'] as const;

export interface RequestRouting {
  preferences?: ProviderPreferences;
  fallbackModels?: string[];
  /** The key's policy is locked and the client's preferences were dropped. */
  clientIgnored: boolean;
  policy: EffectivePolicy;
}

/** Reads the routing fields of a request body; throws a 400 when they are malformed. */
export function routingFromRequest(
  rules: readonly RoutingPolicyRule[],
  key: Pick<VirtualKeyConfig, 'id' | 'organizationId' | 'projectId'>,
  body: unknown,
): RequestRouting {
  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  let client: ProviderPreferences | undefined;
  if (raw.provider !== undefined && raw.provider !== null) {
    const parsed = ProviderRequestObject.safeParse(raw.provider);
    if (!parsed.success)
      throw new DiRouterError('invalid_request', {
        message: `Invalid provider preferences: ${parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.') || 'provider'}: ${i.message}`)
          .join('; ')}`,
        param: 'provider',
      });
    client = preferencesFromRequest(parsed.data);
  }
  let fallbackModels: string[] | undefined;
  if (raw.models !== undefined && raw.models !== null) {
    if (
      !Array.isArray(raw.models) ||
      raw.models.length > MAX_FALLBACK_MODELS ||
      !raw.models.every((m) => typeof m === 'string' && m.length > 0 && m.length <= 256)
    )
      throw new DiRouterError('invalid_request', {
        message: `models must be an array of at most ${String(MAX_FALLBACK_MODELS)} model names`,
        param: 'models',
      });
    fallbackModels = raw.models as string[];
  }
  const policy = effectivePolicy(rules, key);
  const merged = mergePreferences(policy, client);
  const clientIgnored = merged.clientIgnored || (policy.lockProvider && !!fallbackModels?.length);
  return {
    ...(merged.preferences ? { preferences: merged.preferences } : {}),
    // A locked key cannot add models of its own choosing either.
    ...(fallbackModels && !policy.lockProvider ? { fallbackModels } : {}),
    clientIgnored,
    policy,
  };
}

/** The canonical request without the routing fields, so no provider ever receives them. */
export function withoutRoutingFields(request: CanonicalRequest): CanonicalRequest {
  const passthrough = request.passthrough;
  if (!passthrough || !ROUTING_FIELDS.some((f) => f in passthrough)) return request;
  const fields: readonly string[] = ROUTING_FIELDS;
  const rest = Object.fromEntries(Object.entries(passthrough).filter(([k]) => !fields.includes(k)));
  const { passthrough: _drop, ...without } = request;
  return Object.keys(rest).length > 0 ? { ...without, passthrough: rest } : without;
}

/** A failed route plan as the error the client receives. */
export function planErrorToClient(error: PlanError, model: string): DiRouterError {
  switch (error.error) {
    case 'model_not_found':
      return new NotFoundError('model_not_found', {
        message: `Model '${model}' not found`,
        param: 'model',
      });
    case 'model_not_allowed':
      return new ForbiddenError('model_not_allowed', { param: 'model' });
    case 'context_length_exceeded':
      return new DiRouterError('context_length_exceeded', {
        message: `Request needs about ${String(error.neededTokens ?? 0)} tokens (input estimate + max output), more than any model for '${model}' supports`,
      });
    case 'no_provider_matches_preferences':
      return new DiRouterError('no_provider_matches_preferences', {
        message: `No provider for '${model}' matches the provider preferences (${summarize(error.skipped)})`,
        param: 'provider',
      });
    default:
      return new UpstreamError('no_available_provider');
  }
}

/** `above_max_price_prompt ×2, provider_ignored ×1`: why candidates were removed. */
function summarize(skipped: readonly { reason: string }[]): string {
  const counts = new Map<string, number>();
  for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  return [...counts].map(([reason, n]) => `${reason} ×${String(n)}`).join(', ') || 'none left';
}

/** HTTP status of a plan error for the simulator. */
export function planErrorStatus(error: PlanError['error']): number {
  if (error === 'model_not_found') return 404;
  if (error === 'model_not_allowed') return 403;
  if (error === 'no_available_provider') return 503;
  return 400;
}

/**
 * Routing explanation (card 32.7): one view of a route plan, built by the same function for the
 * routing simulator, the `x-dirouter-routing` response header and the request log, so the three
 * always agree for the same request.
 */
import type { ModelConfig } from '@dirouter/contracts';

import type { AttemptRecord } from './executor.js';
import type { RoutePlan } from './plan.js';
import { estimatedPriceUsd } from './preferences.js';

export interface RouteExplanation {
  requested: string;
  /** Model names the candidates came from, in order. */
  models: string[];
  kind: 'model' | 'combo';
  combo?: { slug: string; strategy: string };
  /** The routing rule that chose the target (rules stage), when one matched. */
  rule?: { id: string; name?: string };
  suffixes?: string[];
  dataPolicy?: RoutePlan['dataPolicy'];
  preferences?: RoutePlan['preferences'];
  /** Candidates in attempt order. */
  candidates: {
    modelId: string;
    model: string;
    providerId: string;
    provider: string;
    credentialId: string;
    /** Estimated price of this request on the candidate (USD, input estimate + output cap). */
    estimatedCostUsd: string;
  }[];
  /** Targets removed while planning, with the reason. */
  skipped: RoutePlan['skipped'];
  /** Estimated price on the first candidate. */
  estimatedCostUsd?: string;
  /** The token counts the estimate is based on (input estimate, output cap). */
  estimate: { inputTokens: number; outputTokens: number };
  /** Upstream attempts; only once the request ran. */
  attempts?: {
    modelId: string;
    providerId: string;
    credentialId: string;
    outcome: string;
    status?: number;
    errorClass?: string;
    latencyMs: number;
  }[];
}

export interface ExplainContext {
  estimatedInputTokens?: number | undefined;
  maxOutputTokens?: number | undefined;
  priceMultiplier?: string | undefined;
  /** The pricing actually used (a service tier, card 31.5); defaults to the model's own. */
  priced?: (model: ModelConfig) => ModelConfig;
  rule?: { id: string; name?: string } | undefined;
  suffixes?: readonly string[] | undefined;
}

const MAX_CANDIDATES = 50;
const MAX_SKIPPED = 100;

export function explainPlan(plan: RoutePlan, ctx: ExplainContext = {}): RouteExplanation {
  const price = (m: ModelConfig) =>
    estimatedPriceUsd(
      ctx.priced ? ctx.priced(m) : m,
      ctx.estimatedInputTokens ?? 0,
      ctx.maxOutputTokens ?? 1_024,
      ctx.priceMultiplier,
    ).toFixed(8);
  const candidates = plan.candidates.slice(0, MAX_CANDIDATES).map((c) => ({
    modelId: c.model.id,
    model: c.model.slug,
    providerId: c.provider.id,
    provider: c.provider.slug,
    credentialId: c.credential.id,
    estimatedCostUsd: price(c.model),
  }));
  return {
    requested: plan.requested,
    models: plan.models,
    kind: plan.kind,
    ...(plan.combo ? { combo: { slug: plan.combo.slug, strategy: plan.combo.strategy } } : {}),
    ...((ctx.rule ?? plan.rule) ? { rule: ctx.rule ?? plan.rule } : {}),
    ...(ctx.suffixes && ctx.suffixes.length > 0 ? { suffixes: [...ctx.suffixes] } : {}),
    ...(plan.dataPolicy ? { dataPolicy: plan.dataPolicy } : {}),
    ...(plan.preferences ? { preferences: plan.preferences } : {}),
    candidates,
    skipped: plan.skipped.slice(0, MAX_SKIPPED),
    ...(candidates[0] ? { estimatedCostUsd: candidates[0].estimatedCostUsd } : {}),
    estimate: {
      inputTokens: ctx.estimatedInputTokens ?? 0,
      outputTokens: ctx.maxOutputTokens ?? 1_024,
    },
  };
}

/** One upstream attempt as the explanation shows it. */
export type ExplainAttempt = NonNullable<RouteExplanation['attempts']>[number];

/** The explanation with the attempts of a finished (or streaming) request. */
export function withAttempts(
  explanation: RouteExplanation,
  attempts: readonly (
    | ExplainAttempt
    | Pick<
        AttemptRecord,
        | 'modelId'
        | 'providerId'
        | 'credentialId'
        | 'outcome'
        | 'status'
        | 'errorClass'
        | 'latencyMs'
      >
  )[],
): RouteExplanation {
  return {
    ...explanation,
    attempts: attempts.map((a) => ({
      modelId: a.modelId,
      providerId: a.providerId,
      credentialId: a.credentialId,
      outcome: a.outcome,
      ...(a.status !== undefined ? { status: a.status } : {}),
      ...(a.errorClass ? { errorClass: a.errorClass } : {}),
      latencyMs: a.latencyMs,
    })),
  };
}

/** `x-dirouter-routing` header value: base64url of the JSON explanation. */
export function encodeExplanation(explanation: RouteExplanation): string {
  return Buffer.from(JSON.stringify(explanation)).toString('base64url');
}

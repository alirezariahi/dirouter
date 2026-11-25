/**
 * Request guardrails (cards 15.1 and 23.1) for endpoints whose body is sent upstream as the client
 * wrote it rather than through the canonical chat request: the legacy `/v1/completions` (card
 * 30.4) and the lines of a batch (card 30.1). The same policies as chat run on the body's text with
 * the same engine: a blocking policy refuses the request before anything reaches a provider, and
 * redaction rewrites the text in the body itself, so the provider only sees the redacted text.
 */
import {
  type CanonicalRequest,
  externalPolicies,
  type GuardrailPolicy,
  guardrailText,
  type VirtualKeyConfig,
} from '@dirouter/contracts';
import { estimateRequestTokens, roughTokens } from '@dirouter/model-catalog';
import type { FastifyRequest } from 'fastify';

import { externalVerdicts } from './classifiers.js';
import type { LoadedConfig } from './config-store.js';
import { evaluateGuardrails, policiesFor } from './guardrails.js';
import type { ProxyDeps } from './proxy.js';

/** One piece of prompt text in a request body, readable and writable in place. */
interface TextSlot {
  get(): string;
  set(value: string): void;
}

/** Body fields that carry prompt text, in the OpenAI request shapes a batch line may use. */
const TEXT_FIELDS = ['system', 'instructions', 'messages', 'input', 'prompt', 'suffix'] as const;

function collect(holder: Record<string | number, unknown>, at: string | number, out: TextSlot[]) {
  const value = holder[at];
  if (typeof value === 'string') {
    out.push({
      get: () => holder[at] as string,
      set: (v) => {
        holder[at] = v;
      },
    });
    return;
  }
  if (!Array.isArray(value)) return;
  const list = value as unknown[];
  list.forEach((item, i) => {
    if (typeof item === 'string') {
      collect(list as unknown as Record<number, unknown>, i, out);
      return;
    }
    if (!item || typeof item !== 'object') return;
    const part = item as Record<string, unknown>;
    // A content part (`text`, `input_text`) or a message / input item with its own content.
    if (typeof part.text === 'string') collect(part, 'text', out);
    if (part.content !== undefined) collect(part, 'content', out);
  });
}

/** Every prompt text of a request body (messages, input, prompt, suffix, instructions). */
export function bodyTextSlots(body: Record<string, unknown>): TextSlot[] {
  const out: TextSlot[] = [];
  for (const field of TEXT_FIELDS) collect(body, field, out);
  return out;
}

export interface BodyGuardResult {
  /** The first body a policy blocks, with the client-facing message. */
  blocked?: { index: number; message: string; policy: GuardrailPolicy };
  redactions: number;
}

/** How many bodies have their moderation or classifier calls made at once. */
const EXTERNAL_CONCURRENCY = 8;

/**
 * Runs the key's request guardrails on each body, in place. Stops at the first blocked body.
 * Moderation and classifier policies make their model call per body, billed to the key like the
 * chat path's.
 */
export async function guardBodies(
  req: FastifyRequest,
  deps: ProxyDeps,
  config: LoadedConfig,
  key: VirtualKeyConfig,
  bodies: readonly Record<string, unknown>[],
): Promise<BodyGuardResult> {
  const policies = policiesFor(config.snapshot.guardrails, key);
  const result: BodyGuardResult = { redactions: 0 };
  if (policies.length === 0) return result;
  const external = externalPolicies(policies, 'request').length > 0;

  const prepare = (body: Record<string, unknown>) => {
    const slots = bodyTextSlots(body);
    const request: CanonicalRequest = {
      inboundApi: 'openai.chat',
      model: typeof body.model === 'string' ? body.model : '',
      system: [],
      messages: slots.map((slot) => ({
        role: 'user' as const,
        content: [{ type: 'text' as const, text: slot.get() }],
      })),
      stream: false,
    };
    return { slots, request };
  };
  // A model call of its own per body: its request id must not collide with another body's.
  const requestFor = (i: number): FastifyRequest =>
    bodies.length === 1
      ? req
      : (Object.create(req, { id: { value: `${req.id}-line-${String(i)}` } }) as FastifyRequest);

  for (let start = 0; start < bodies.length; start += EXTERNAL_CONCURRENCY) {
    const chunk = bodies.slice(start, start + EXTERNAL_CONCURRENCY).map((body, j) => {
      const prepared = prepare(body);
      return { ...prepared, index: start + j };
    });
    const verdicts = external
      ? await Promise.all(
          chunk.map((c) =>
            externalVerdicts(
              requestFor(c.index),
              deps,
              policies,
              'request',
              guardrailText({ stage: 'request', request: c.request }),
            ),
          ),
        )
      : [];
    for (const [j, c] of chunk.entries()) {
      const guard = evaluateGuardrails(policies, {
        stage: 'request',
        request: c.request,
        estimatedInputTokens: estimateRequestTokens(c.request, roughTokens),
        ...(verdicts[j] ? { external: verdicts[j] } : {}),
      });
      if (guard.hits.length > 0)
        deps.logger.info(
          {
            requestId: req.id,
            ...(bodies.length > 1 ? { line: c.index + 1 } : {}),
            stage: 'request',
            guardrails: guard.hits.map((hit) => ({
              policyId: hit.policyId,
              type: hit.type,
              action: hit.action,
              matches: hit.matches,
            })),
          },
          'guardrail hits',
        );
      for (const policy of guard.unknown) {
        deps.metrics?.guardrailUnknown(policy.type);
        deps.logger.warn(
          { requestId: req.id, stage: 'request', policyId: policy.id, type: policy.type },
          'guardrail policy of an unknown type was not enforced',
        );
      }
      if (guard.blocked) {
        deps.metrics?.reject('guardrail', guard.blocked.policy.type);
        return { ...result, blocked: { index: c.index, ...guard.blocked } };
      }
      if (guard.redactions === 0) continue;
      result.redactions += guard.redactions;
      c.slots.forEach((slot, k) => {
        const part = c.request.messages[k]?.content[0];
        if (part?.type === 'text' && part.text !== slot.get()) slot.set(part.text);
      });
    }
  }
  if (result.redactions > 0)
    deps.logger.info(
      { requestId: req.id, redactions: result.redactions },
      'guardrail redactions applied',
    );
  return result;
}

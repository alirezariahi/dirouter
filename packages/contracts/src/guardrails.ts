/**
 * Guardrail policies (card 15.1): rules evaluated on the request before routing or on the
 * response before it is sent back. Policies live in the config snapshot so the gateway evaluates
 * them without control-plane round trips.
 */
import { z } from 'zod';

export const GuardrailStage = z.enum(['request', 'response', 'both']);
export type GuardrailStage = z.infer<typeof GuardrailStage>;

/**
 * - `regex`: a regular expression in `config.pattern` (optional `flags`)
 * - `keyword`: comma or array of words in `config.terms`, optional `config.caseSensitive`
 * - `pii`: built-in detectors (`email`, `credit_card`, `iban`, `national_id`, `phone`)
 * - `max_input_tokens`: rejects requests whose estimated input exceeds `config.maxTokens`
 * - `prompt_injection`: heuristic score for instruction-override patterns
 * - `secret`: provider tokens, API keys and private-key material
 * - `json_schema`: response text must parse and satisfy a small JSON Schema subset
 */
export const GuardrailType = z.enum([
  'regex',
  'keyword',
  'pii',
  'secret',
  'json_schema',
  'max_input_tokens',
  'prompt_injection',
]);
export type GuardrailType = z.infer<typeof GuardrailType>;

/** `block` rejects the request; `redact` replaces the matched text; `flag` only records a hit. */
export const GuardrailAction = z.enum(['block', 'redact', 'flag']);
export type GuardrailAction = z.infer<typeof GuardrailAction>;

export const GuardrailPolicy = z.object({
  id: z.string(),
  organizationId: z.string(),
  /** Optional key/project scope; an unscoped policy applies to the whole organization. */
  virtualKeyId: z.string().optional(),
  projectId: z.string().optional(),
  name: z.string(),
  enabled: z.boolean(),
  stage: GuardrailStage.default('both'),
  type: GuardrailType,
  config: z.record(z.string(), z.unknown()).default({}),
  action: GuardrailAction.default('block'),
  /** Message returned to the client on a block; a sane default is used when absent. */
  message: z.string().optional(),
});
export type GuardrailPolicy = z.infer<typeof GuardrailPolicy>;

export const GuardrailHit = z.object({
  policyId: z.string(),
  name: z.string(),
  type: GuardrailType,
  action: GuardrailAction,
  /** Number of matches (for flag/redact) or the estimated amount (for max_input_tokens). */
  matches: z.int().nonnegative(),
});
export type GuardrailHit = z.infer<typeof GuardrailHit>;

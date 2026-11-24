/**
 * Request body capture (card 24.1): what the gateway keeps of a request's payload, per organization,
 * project or virtual key, and the record it hands to the worker.
 *
 * Bodies never travel with usage events: they go to their own best-effort queue
 * (`REQUEST_BODIES_QUEUE`) and their own partitioned table, so a large prompt never slows down
 * billing and a lost body never loses money.
 */
import { z } from 'zod';

import { InboundApi } from './canonical.js';
import { IsoDateTime } from './common.js';

export const REQUEST_BODIES_QUEUE = 'request-bodies';

/**
 * - `none`: nothing is kept (the default)
 * - `metadata`: the shape only (model, parameters, message roles and counts, tool names, sizes),
 *   never the text
 * - `full`: the request and the answer, after redaction, cut at `settings.bodyCapture.maxBytes`
 */
export const BodyCaptureLevel = z.enum(['none', 'metadata', 'full']);
export type BodyCaptureLevel = z.infer<typeof BodyCaptureLevel>;

export const BodyCaptureScope = z.enum(['organization', 'project', 'key']);
export type BodyCaptureScope = z.infer<typeof BodyCaptureScope>;

/** One explicit level; the most specific one wins (key, then project, then organization). */
export const BodyCaptureRule = z.object({
  organizationId: z.string(),
  scope: BodyCaptureScope,
  /** The organization, project or virtual key id. */
  scopeId: z.string(),
  level: BodyCaptureLevel,
});
export type BodyCaptureRule = z.infer<typeof BodyCaptureRule>;

export const BodyCaptureSettings = z.object({
  /** Level for keys without a rule; `logBodies: true` means `full` when this is absent. */
  defaultLevel: BodyCaptureLevel.optional(),
  /** Upper bound of each stored part (request and answer), in UTF-8 bytes. */
  maxBytes: z.int().min(1_024).max(1_048_576).default(65_536),
});
export type BodyCaptureSettings = z.infer<typeof BodyCaptureSettings>;

/** Default upper bound of each stored part when the settings give none. */
export const DEFAULT_BODY_MAX_BYTES = 65_536;

/**
 * Effective level for a key: its own rule, else its project's, else its organization's, else the
 * instance default. Without any of these nothing is captured.
 */
export function bodyCaptureLevel(
  rules: readonly BodyCaptureRule[],
  key: { id: string; organizationId: string; projectId: string },
  settings: { logBodies?: boolean; bodyCapture?: { defaultLevel?: BodyCaptureLevel } | undefined },
): BodyCaptureLevel {
  let project: BodyCaptureLevel | undefined;
  let organization: BodyCaptureLevel | undefined;
  for (const rule of rules) {
    if (rule.organizationId !== key.organizationId) continue;
    if (rule.scope === 'key' && rule.scopeId === key.id) return rule.level;
    if (rule.scope === 'project' && rule.scopeId === key.projectId) project = rule.level;
    if (rule.scope === 'organization' && rule.scopeId === key.organizationId)
      organization = rule.level;
  }
  return (
    project ??
    organization ??
    settings.bodyCapture?.defaultLevel ??
    (settings.logBodies === true ? 'full' : 'none')
  );
}

/** A text conversation the playground can run again with any model. */
export const ReplayDraft = z.object({
  system: z.string().optional(),
  /** Every turn before the last user message, as plain text. */
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })),
  /** The last user message. */
  prompt: z.string(),
  maxTokens: z.int().positive().optional(),
  temperature: z.number().optional(),
  /** Parts the playground cannot send (images, tool calls, audio) were left out. */
  lossy: z.boolean(),
});
export type ReplayDraft = z.infer<typeof ReplayDraft>;

export const BodyMetadata = z.object({
  model: z.string().optional(),
  stream: z.boolean().optional(),
  /** Parameter names the client set (temperature, max_tokens, tools, …), never their values. */
  parameters: z.array(z.string()),
  messages: z.int().nonnegative(),
  roles: z.record(z.string(), z.int().nonnegative()),
  tools: z.array(z.string()),
  requestBytes: z.int().nonnegative(),
  responseBytes: z.int().nonnegative(),
  finishReason: z.string().optional(),
});
export type BodyMetadata = z.infer<typeof BodyMetadata>;

/** What the gateway queues for the worker; one per request, idempotent by `requestId`. */
export const RequestBodyRecord = z.object({
  requestId: z.string().min(1),
  /** Same instant as the usage event's `occurredAt`, so the row sits next to its log entry. */
  createdAt: IsoDateTime,
  organizationId: z.string(),
  projectId: z.string(),
  apiKeyId: z.string(),
  inboundApi: InboundApi,
  level: z.enum(['metadata', 'full']),
  metadata: BodyMetadata,
  /** Redacted JSON text of the request as the client sent it; absent at `metadata`. */
  request: z.string().optional(),
  requestTruncated: z.boolean().default(false),
  /** Redacted JSON text of the answer (a streamed answer is rebuilt as one JSON answer). */
  response: z.string().optional(),
  responseTruncated: z.boolean().default(false),
  /** The answer was streamed; `response` is its reconstruction, not the bytes on the wire. */
  streamed: z.boolean().default(false),
  /** Matches masked before the body left the gateway. */
  redactions: z.int().nonnegative().default(0),
  replay: ReplayDraft.optional(),
});
export type RequestBodyRecord = z.infer<typeof RequestBodyRecord>;
export type RequestBodyRecordInput = z.input<typeof RequestBodyRecord>;

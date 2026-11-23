/**
 * MCP gateway records (card 20.1): one per tool call, published by the gateway to the `mcp-calls`
 * queue and written to Postgres by the worker. Arguments are masked before they leave the gateway.
 */
import { z } from 'zod';

import { IsoDateTime, NonNegativeInt } from './common.js';

export const MCP_CALLS_QUEUE = 'mcp-calls';

export const McpCallRecord = z.object({
  id: z.string(),
  occurredAt: IsoDateTime,
  organizationId: z.string(),
  projectId: z.string(),
  virtualKeyId: z.string(),
  serverId: z.string(),
  /** Tool name at the upstream server (without the `server__` prefix). */
  tool: z.string(),
  /** Masked: secrets replaced, long values cut. */
  arguments: z.record(z.string(), z.unknown()),
  status: z.enum(['success', 'error', 'denied']),
  errorMessage: z.string().max(500).optional(),
  latencyMs: NonNegativeInt,
  gatewayInstance: z.string(),
});
export type McpCallRecord = z.infer<typeof McpCallRecord>;

/** Separator between the server slug and the tool name in the aggregated tool list. */
export const MCP_TOOL_SEPARATOR = '__';

/** `*`, `server__*` or an exact `server__tool`; an empty list allows everything. */
export function mcpToolAllowed(allowlist: readonly string[], name: string): boolean {
  if (allowlist.length === 0) return true;
  return allowlist.some((pattern) =>
    pattern === '*'
      ? true
      : pattern.endsWith('*')
        ? name.startsWith(pattern.slice(0, -1))
        : pattern === name,
  );
}

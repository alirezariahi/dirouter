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

/**
 * Shared OAuth 2.1 credential of an organization for one upstream MCP server (card 28.1), stored
 * encrypted. `client_credentials` gets tokens with the client secret alone; `authorization_code`
 * is connected once by an administrator, after which the stored refresh token keeps it working.
 * Endpoints are discovered from the server URL (RFC 9728, RFC 8414) unless given.
 */
export const McpOAuthConfig = z.object({
  grantType: z.enum(['client_credentials', 'authorization_code']),
  clientId: z.string().min(1).max(500),
  clientSecret: z.string().max(4096).optional(),
  scope: z.string().max(1000).optional(),
  /** Skips protected resource metadata and discovers this authorization server directly. */
  issuer: z.url().optional(),
  /** Skips discovery altogether. */
  tokenEndpoint: z.url().optional(),
  authorizationEndpoint: z.url().optional(),
  tokenEndpointAuthMethod: z.enum(['client_secret_basic', 'client_secret_post', 'none']).optional(),
  /** Set by the authorization code exchange; the gateway may rotate it afterwards. */
  refreshToken: z.string().max(8192).optional(),
});
export type McpOAuthConfig = z.infer<typeof McpOAuthConfig>;

/** Separator between the server slug and an upstream resource URI: `<slug>+<uri>`. */
export const MCP_URI_SEPARATOR = '+';

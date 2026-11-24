/**
 * Connection test and tool discovery for a registered MCP server or A2A agent (card 25.3), for
 * control-api. Runs in the gateway so the same client, transports and timeouts as real traffic are
 * used; the headers arrive encrypted (AAD `mcp:<id>`) and are only decrypted here, in memory.
 *
 * A fresh connection is opened for every test, so the answer reflects the server as it is now and
 * not a connection the gateway already holds.
 */
import { McpServerConfig } from '@dirouter/contracts';
import { decrypt, type Keyring, type Logger, ValidationError } from '@dirouter/shared';
import { z } from 'zod';

import { McpUpstream } from './upstream.js';

export const McpProbeRequest = z.object({ server: McpServerConfig });

export interface McpProbeTool {
  name: string;
  description?: string;
}

export interface McpProbeResult {
  ok: boolean;
  latencyMs: number;
  /** Tools of an MCP server, or skills of an A2A agent. */
  tools: McpProbeTool[];
  /** Name of the agent from its card (A2A only). */
  agentName?: string;
  error?: string;
}

const MAX_PAGES = 20;
const PROBE_TIMEOUT_MS = 15_000;

function describe(item: unknown): McpProbeTool | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const record = item as Record<string, unknown>;
  const name =
    typeof record.name === 'string'
      ? record.name
      : typeof record.id === 'string'
        ? record.id
        : undefined;
  if (!name) return undefined;
  return {
    name,
    ...(typeof record.description === 'string'
      ? { description: record.description.slice(0, 500) }
      : {}),
  };
}

async function agentCard(url: string, headers: Record<string, string>, timeoutMs: number) {
  // Same lookup as the A2A proxy: under the agent's path first, then at the origin root.
  let lastError = 'agent card unavailable';
  for (const candidate of [
    `${url.replace(/\/+$/, '')}/.well-known/agent-card.json`,
    new URL('/.well-known/agent-card.json', url).toString(),
  ]) {
    const res = await fetch(candidate, { headers, signal: AbortSignal.timeout(timeoutMs) }).catch(
      (error: unknown) => {
        lastError = error instanceof Error ? error.message : String(error);
        return undefined;
      },
    );
    if (res?.ok) return (await res.json()) as Record<string, unknown>;
    if (res) lastError = `agent card returned HTTP ${String(res.status)}`;
  }
  throw new Error(lastError);
}

export async function probeMcpServer(
  body: unknown,
  keyring: Keyring,
  logger: Logger,
): Promise<McpProbeResult> {
  const parsed = McpProbeRequest.safeParse(body);
  if (!parsed.success)
    throw new ValidationError(
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  const { server } = parsed.data;
  const headers = server.headers
    ? (JSON.parse(decrypt(keyring, server.headers, `mcp:${server.id}`)) as Record<string, string>)
    : {};
  const timeoutMs = Math.min(server.timeoutMs, PROBE_TIMEOUT_MS);
  const started = Date.now();
  if (server.transport === 'a2a') {
    try {
      const card = await agentCard(server.url, headers, timeoutMs);
      const skills = Array.isArray(card.skills) ? card.skills : [];
      return {
        ok: true,
        latencyMs: Date.now() - started,
        tools: skills.map(describe).filter((s): s is McpProbeTool => s !== undefined),
        ...(typeof card.name === 'string' ? { agentName: card.name } : {}),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        tools: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const client = new McpUpstream(
    { url: server.url, transport: server.transport, headers, timeoutMs },
    logger,
  );
  try {
    const tools: McpProbeTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = (await client.request('tools/list', cursor ? { cursor } : {})) as {
        tools?: unknown[];
        nextCursor?: string;
      };
      for (const tool of result.tools ?? []) {
        const described = describe(tool);
        if (described) tools.push(described);
      }
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return { ok: true, latencyMs: Date.now() - started, tools };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      tools: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    client.reset();
  }
}

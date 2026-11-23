import { Controller, Delete, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AdminMcpService, AdminToolError } from './admin-mcp.service.js';

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

interface Rpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const error = (id: Rpc['id'], code: number, message: string) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message },
});

/**
 * DiRouter's admin MCP server over Streamable HTTP (stateless JSON responses), authenticated with a
 * virtual key that an owner or admin granted `mcpAdmin` access (card 20.2):
 *   claude mcp add --transport http dirouter-admin https://admin.<domain>/api/v1/mcp \
 *     --header "Authorization: Bearer dr-…"
 */
@ApiExcludeController()
@Controller('mcp')
export class AdminMcpController {
  constructor(@Inject(AdminMcpService) private readonly mcp: AdminMcpService) {}

  @Post()
  @HttpCode(200)
  async handle(@Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const auth = req.headers.authorization;
    const raw =
      typeof auth === 'string' && /^Bearer\s+/i.test(auth)
        ? auth.replace(/^Bearer\s+/i, '').trim()
        : undefined;
    let key;
    try {
      key = await this.mcp.authenticate(raw, req.ip);
    } catch (e) {
      const status = (e as { status?: number }).status ?? 401;
      await reply
        .status(status)
        .send(error(null, -32001, e instanceof Error ? e.message : 'unauthenticated'));
      return;
    }
    const batch = Array.isArray(req.body);
    const messages = (batch ? req.body : [req.body]) as Rpc[];
    const answers = [];
    for (const m of messages) {
      if (typeof m !== 'object' || m.jsonrpc !== '2.0' || typeof m.method !== 'string') {
        answers.push(error(m.id, -32600, 'Invalid request'));
        continue;
      }
      if (m.id === undefined || m.id === null) continue;
      try {
        answers.push({ jsonrpc: '2.0', id: m.id, result: await this.#dispatch(key, m) });
      } catch (e) {
        if (e instanceof AdminToolError) answers.push(error(m.id, e.code, e.message));
        else
          answers.push({
            jsonrpc: '2.0',
            id: m.id,
            // A failing tool is reported to the model as a tool error, not a protocol error.
            result: {
              content: [{ type: 'text', text: e instanceof Error ? e.message : 'failed' }],
              isError: true,
            },
          });
      }
    }
    if (answers.length === 0) await reply.status(202).send();
    else await reply.status(200).send(batch ? answers : answers[0]);
  }

  async #dispatch(key: Awaited<ReturnType<AdminMcpService['authenticate']>>, m: Rpc) {
    switch (m.method) {
      case 'initialize': {
        const requested = m.params?.protocolVersion;
        return {
          protocolVersion:
            typeof requested === 'string' && PROTOCOLS.includes(requested)
              ? requested
              : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'DiRouter admin', version: '1.0.0' },
          instructions:
            key.mcpAdmin === 'write'
              ? 'DiRouter status, usage and routing; this key may also create API keys.'
              : 'DiRouter status, usage and routing (read-only for this key).',
        };
      }
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: this.mcp.tools(key) };
      case 'tools/call': {
        const name = typeof m.params?.name === 'string' ? m.params.name : '';
        const args = (m.params?.arguments as Record<string, unknown> | undefined) ?? {};
        return this.mcp.call(key, name, args);
      }
      case 'resources/list':
        return { resources: [] };
      case 'prompts/list':
        return { prompts: [] };
      default:
        throw new AdminToolError(-32601, `Method not found: ${m.method ?? ''}`);
    }
  }

  /** Stateless: no server-initiated stream and no session to end. */
  @Get()
  @Delete()
  async other(@Res() reply: FastifyReply) {
    await reply.status(405).header('allow', 'POST').send({ error: 'Method not allowed' });
  }
}

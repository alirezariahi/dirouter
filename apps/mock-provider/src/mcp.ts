/**
 * Fake MCP servers (card 20.1) for the gateway's tests and the dev stack.
 *
 * - Streamable HTTP at POST /mcp/:name: issues an `Mcp-Session-Id`, refuses unknown sessions with
 *   404, pages tools/list three at a time, and answers over SSE when the name ends in `-sse`.
 * - HTTP+SSE (2024-11-05) at GET /mcp-legacy/:name, messages POSTed to the announced endpoint.
 * - POST /__mcp/expire forgets every session (tests session renewal); GET /__mcp/calls lists calls
 *   with the headers they carried.
 *
 * Tools: echo, add, whoami (returns the X-DiRouter-* headers it received), fail (isError).
 */
import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';

import type { FastifyInstance, FastifyRequest } from 'fastify';

interface Rpc {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: { name?: string; arguments?: Record<string, unknown>; cursor?: string };
}

const TOOLS = [
  {
    name: 'echo',
    description: 'Returns the text it was given',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'add',
    description: 'Adds two numbers',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
  {
    name: 'whoami',
    description: 'Shows the caller identity headers forwarded by the gateway',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'fail',
    description: 'Always reports a tool error',
    inputSchema: { type: 'object', properties: {} },
  },
];
const PAGE = 3;

const text = (value: string) => ({ content: [{ type: 'text', text: value }] });

export function registerMcp(app: FastifyInstance): void {
  const sessions = new Set<string>();
  const legacy = new Map<string, ServerResponse>();
  const calls: { server: string; tool: string; headers: Record<string, string> }[] = [];

  const identity = (req: FastifyRequest) =>
    Object.fromEntries(
      Object.entries(req.headers).filter(
        (e): e is [string, string] => e[0].startsWith('x-dirouter-') && typeof e[1] === 'string',
      ),
    );

  function answer(server: string, message: Rpc, req: FastifyRequest) {
    switch (message.method) {
      case 'initialize':
        return {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: `mock-${server}`, version: '1.0.0' },
        };
      case 'tools/list': {
        const start = Number(message.params?.cursor ?? 0);
        const page = TOOLS.slice(start, start + PAGE);
        return {
          tools: page,
          ...(start + PAGE < TOOLS.length ? { nextCursor: String(start + PAGE) } : {}),
        };
      }
      case 'tools/call': {
        const tool = message.params?.name ?? '';
        const args = message.params?.arguments ?? {};
        calls.push({ server, tool, headers: identity(req) });
        if (tool === 'echo') return text(String(args.text));
        if (tool === 'add') return text(String(Number(args.a) + Number(args.b)));
        if (tool === 'whoami') return text(JSON.stringify(identity(req)));
        if (tool === 'fail') return { ...text('it failed on purpose'), isError: true };
        throw Object.assign(new Error(`Unknown tool: ${tool}`), { code: -32602 });
      }
      case 'ping':
        return {};
      default:
        throw Object.assign(new Error(`Method not found: ${message.method}`), { code: -32601 });
    }
  }

  const respond = (server: string, message: Rpc, req: FastifyRequest) => {
    try {
      return { jsonrpc: '2.0', id: message.id, result: answer(server, message, req) };
    } catch (error) {
      const e = error as Error & { code?: number };
      return {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: e.code ?? -32603, message: e.message },
      };
    }
  };

  // ───────────── Streamable HTTP ─────────────

  app.post<{ Params: { name: string }; Body: Rpc }>('/mcp/:name', async (req, reply) => {
    const message = req.body;
    const session = req.headers['mcp-session-id'];
    if (message.method === 'initialize') {
      const id = `sess-${randomBytes(8).toString('hex')}`;
      sessions.add(id);
      void reply.header('mcp-session-id', id);
    } else if (typeof session !== 'string' || !sessions.has(session)) {
      return reply.status(404).send({ error: 'unknown session' });
    }
    if (message.id === undefined) return reply.status(202).send();
    const body = respond(req.params.name, message, req);
    if (!req.params.name.endsWith('-sse')) return body;
    // Same answer as an SSE stream, with a progress notification first.
    reply.hijack();
    const issued = reply.getHeader('mcp-session-id');
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      ...(typeof issued === 'string' ? { 'mcp-session-id': issued } : {}),
    });
    reply.raw.write(
      `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })}\n\n`,
    );
    reply.raw.end(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
    return reply;
  });

  // ───────────── HTTP+SSE (2024-11-05) ─────────────

  app.get<{ Params: { name: string } }>('/mcp-legacy/:name', (req, reply) => {
    const id = randomBytes(8).toString('hex');
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    reply.raw.write(
      `event: endpoint\ndata: /mcp-legacy/${req.params.name}/messages?sessionId=${id}\n\n`,
    );
    legacy.set(id, reply.raw);
    req.raw.on('close', () => legacy.delete(id));
  });

  app.post<{ Params: { name: string }; Querystring: { sessionId?: string }; Body: Rpc }>(
    '/mcp-legacy/:name/messages',
    (req, reply) => {
      const stream = legacy.get(req.query.sessionId ?? '');
      if (!stream) return reply.status(404).send({ error: 'unknown session' });
      if (req.body.id !== undefined)
        stream.write(
          `event: message\ndata: ${JSON.stringify(respond(req.params.name, req.body, req))}\n\n`,
        );
      return reply.status(202).send();
    },
  );

  app.post('/__mcp/expire', () => {
    sessions.clear();
    return { ok: true };
  });
  app.get('/__mcp/calls', () => calls);
}

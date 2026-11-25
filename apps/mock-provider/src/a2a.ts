/**
 * A fake external A2A agent (card 20.3): card at /a2a-agent/.well-known/agent-card.json and
 * JSON-RPC at POST /a2a-agent. It answers both protocol versions by echoing the message, and
 * reports the X-DiRouter-* headers it received in the task metadata. `SendStreamingMessage`
 * answers the echo as an SSE stream (card 28.2). POST /__hooks/:name records webhook calls (push
 * notifications) and GET /__hooks/:name lists them; PUT /__hooks/:name/fail with `{count}` makes
 * the next deliveries to that name answer 500 (job webhook retries, card 30.6).
 */
import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

interface Rpc {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: { message?: { parts?: { text?: string }[]; contextId?: string } };
}

export function registerA2a(app: FastifyInstance): void {
  // Webhook sink for A2A push notifications (card 28.2): records each POST with its headers and
  // the raw body (needed to check the signature); GET returns what arrived.
  const hooks = new Map<
    string,
    { headers: Record<string, unknown>; body: string; status: number }[]
  >();
  const failing = new Map<string, number>();
  app.register((scope, _opts, done) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, next) => {
      next(null, body);
    });
    scope.post<{ Params: { name: string }; Body: string }>('/__hooks/:name', (req, reply) => {
      const list = hooks.get(req.params.name) ?? [];
      const fail = failing.get(req.params.name) ?? 0;
      if (fail > 0) failing.set(req.params.name, fail - 1);
      const status = fail > 0 ? 500 : 204;
      list.push({ headers: req.headers, body: req.body, status });
      hooks.set(req.params.name, list.slice(-50));
      return reply.status(status).send();
    });
    done();
  });
  app.get<{ Params: { name: string } }>(
    '/__hooks/:name',
    (req) => hooks.get(req.params.name) ?? [],
  );
  app.put<{ Params: { name: string }; Body: { count?: number } | undefined }>(
    '/__hooks/:name/fail',
    (req) => {
      failing.set(req.params.name, req.body?.count ?? 1);
      return { failing: failing.get(req.params.name) };
    },
  );

  app.get('/a2a-agent/.well-known/agent-card.json', (req) => {
    const url = `http://${req.headers.host ?? 'localhost'}/a2a-agent`;
    return {
      name: 'Echo agent',
      description: 'Echoes every message',
      supportedInterfaces: [{ url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
      version: '1.0.0',
      capabilities: { streaming: false },
      securitySchemes: {
        apiKey: { apiKeySecurityScheme: { name: 'x-agent-key', location: 'header' } },
      },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: [{ id: 'echo', name: 'Echo', description: 'Repeats the message', tags: ['test'] }],
    };
  });

  app.post<{ Body: Rpc }>('/a2a-agent', (req, reply) => {
    if (req.headers['x-agent-key'] !== 'agent-secret')
      return reply.status(401).send({
        jsonrpc: '2.0',
        id: req.body.id,
        error: { code: -32001, message: 'bad agent key' },
      });
    const { method, params, id } = req.body;
    const text = (params?.message?.parts ?? []).map((p) => p.text ?? '').join(' ');
    const identity = Object.fromEntries(
      Object.entries(req.headers).filter(([k]) => k.startsWith('x-dirouter-')),
    );
    if (method === 'SendMessage')
      return {
        jsonrpc: '2.0',
        id,
        result: {
          task: {
            id: randomUUID(),
            contextId: params?.message?.contextId ?? randomUUID(),
            status: { state: 'TASK_STATE_COMPLETED' },
            artifacts: [{ artifactId: 'a1', parts: [{ text: `echo: ${text}` }] }],
            metadata: { identity },
          },
        },
      };
    if (method === 'message/send')
      return {
        jsonrpc: '2.0',
        id,
        result: {
          kind: 'task',
          id: randomUUID(),
          contextId: randomUUID(),
          status: { state: 'completed' },
          artifacts: [{ artifactId: 'a1', parts: [{ kind: 'text', text: `echo: ${text}` }] }],
        },
      };
    if (method === 'SendStreamingMessage') {
      // Card 28.2: the same echo as a v1.0 stream (Task, artifact, final status).
      const taskId = randomUUID();
      const contextId = params?.message?.contextId ?? randomUUID();
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      for (const result of [
        { task: { id: taskId, contextId, status: { state: 'TASK_STATE_WORKING' } } },
        {
          artifactUpdate: {
            taskId,
            contextId,
            artifact: { artifactId: 'a1', parts: [{ text: `echo: ${text}` }] },
            lastChunk: true,
          },
        },
        { statusUpdate: { taskId, contextId, status: { state: 'TASK_STATE_COMPLETED' } } },
      ])
        reply.raw.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`);
      reply.raw.end();
      return reply;
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
  });
}

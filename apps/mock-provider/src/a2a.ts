/**
 * A fake external A2A agent (card 20.3): card at /a2a-agent/.well-known/agent-card.json and
 * JSON-RPC at POST /a2a-agent. It answers both protocol versions by echoing the message, and
 * reports the X-DiRouter-* headers it received in the task metadata.
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
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
  });
}

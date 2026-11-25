/**
 * Fake MCP servers (card 20.1) for the gateway's tests and the dev stack.
 *
 * - Streamable HTTP at POST /mcp/:name: issues an `Mcp-Session-Id`, refuses unknown sessions with
 *   404, pages tools/list three at a time, and answers over SSE when the name ends in `-sse`.
 * - HTTP+SSE (2024-11-05) at GET /mcp-legacy/:name, messages POSTed to the announced endpoint.
 * - POST /__mcp/expire forgets every session (tests session renewal); GET /__mcp/calls lists calls
 *   with the headers they carried.
 *
 * Tools: echo, add, whoami (returns the X-DiRouter-* headers it received), fail (isError),
 * link (returns a resource link). Resources (card 28.1): `mock://readme`, `file:///notes/today.md`,
 * template `mock://items/{id}`; prompt `greet` (argument `name`, embeds the readme).
 *
 * OAuth (card 28.1): POST /mcp-oauth/:name is the same server behind OAuth 2.1. It answers 401
 * with a `WWW-Authenticate` challenge pointing at its protected resource metadata (RFC 9728); the
 * authorization server at /oauth publishes RFC 8414 metadata and issues tokens by client
 * credentials, authorization code (PKCE S256) and rotating refresh tokens, bound to the `resource`
 * asked for. POST /__oauth/config sets `{ttlSeconds, refreshWithClientCredentials}`, POST
 * /__oauth/revoke drops every access token, GET /__oauth/stats counts grants.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

interface Rpc {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: { name?: string; arguments?: Record<string, unknown>; cursor?: string; uri?: string };
}

/** The mock's OAuth test credential; not a secret anywhere. */
export const MOCK_OAUTH_CLIENT = { clientId: 'mock-client', clientSecret: 'mock-client-pass' };

const RESOURCES = [
  { uri: 'mock://readme', name: 'readme', mimeType: 'text/plain', description: 'About the server' },
  { uri: 'file:///notes/today.md', name: 'today', mimeType: 'text/markdown' },
];
const RESOURCE_TEXT: Record<string, string> = {
  'mock://readme': 'This is the mock MCP server.',
  'file:///notes/today.md': '# Today\n- test the gateway',
};
const TEMPLATES = [{ uriTemplate: 'mock://items/{id}', name: 'item', mimeType: 'text/plain' }];
const PROMPTS = [
  {
    name: 'greet',
    description: 'Greets someone by name',
    arguments: [{ name: 'name', description: 'Who to greet', required: true }],
  },
];

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
  {
    name: 'link',
    description: 'Returns a link to the readme resource',
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
          capabilities: { tools: {}, resources: {}, prompts: {} },
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
        if (tool === 'link')
          return {
            content: [
              {
                type: 'resource_link',
                uri: 'mock://readme',
                name: 'readme',
                mimeType: 'text/plain',
              },
            ],
          };
        throw Object.assign(new Error(`Unknown tool: ${tool}`), { code: -32602 });
      }
      case 'resources/list': {
        // Pages one at a time, to prove the gateway follows the cursor here too.
        const start = Number(message.params?.cursor ?? 0);
        return {
          resources: RESOURCES.slice(start, start + 1),
          ...(start + 1 < RESOURCES.length ? { nextCursor: String(start + 1) } : {}),
        };
      }
      case 'resources/templates/list':
        return { resourceTemplates: TEMPLATES };
      case 'resources/read': {
        const uri = message.params?.uri ?? '';
        const item = /^mock:\/\/items\/(.+)$/.exec(uri);
        const value = RESOURCE_TEXT[uri] ?? (item ? `item ${item[1] ?? ''}` : undefined);
        if (value === undefined)
          throw Object.assign(new Error(`Resource not found: ${uri}`), { code: -32002 });
        return { contents: [{ uri, mimeType: 'text/plain', text: value }] };
      }
      case 'prompts/list':
        return { prompts: PROMPTS };
      case 'prompts/get': {
        if (message.params?.name !== 'greet')
          throw Object.assign(new Error(`Unknown prompt: ${message.params?.name ?? ''}`), {
            code: -32602,
          });
        const name = message.params.arguments?.name;
        const who = typeof name === 'string' ? name : 'stranger';
        return {
          description: 'A greeting',
          messages: [
            { role: 'user', content: { type: 'text', text: `Say hello to ${who}.` } },
            {
              role: 'user',
              content: {
                type: 'resource',
                resource: {
                  uri: 'mock://readme',
                  mimeType: 'text/plain',
                  text: RESOURCE_TEXT['mock://readme'],
                },
              },
            },
          ],
        };
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

  const streamable = async (
    req: FastifyRequest<{ Params: { name: string }; Body: Rpc }>,
    reply: FastifyReply,
  ) => {
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
  };
  app.post<{ Params: { name: string }; Body: Rpc }>('/mcp/:name', streamable);

  // ───────────── OAuth 2.1 (card 28.1) ─────────────

  const oauth = {
    ttlSeconds: 3600,
    refreshWithClientCredentials: false,
    access: new Map<string, { resource: string; expiresAt: number }>(),
    refresh: new Map<string, { resource: string }>(),
    codes: new Map<string, { challenge: string; redirectUri: string; resource: string }>(),
    stats: { client_credentials: 0, authorization_code: 0, refresh_token: 0, rejected: 0 },
  };
  const origin = (req: FastifyRequest) => `${req.protocol}://${req.headers.host ?? 'localhost'}`;
  const issue = (resource: string, withRefresh: boolean) => {
    const accessToken = `at-${randomBytes(12).toString('hex')}`;
    oauth.access.set(accessToken, { resource, expiresAt: Date.now() + oauth.ttlSeconds * 1000 });
    const refreshToken = withRefresh ? `rt-${randomBytes(12).toString('hex')}` : undefined;
    if (refreshToken) oauth.refresh.set(refreshToken, { resource });
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: oauth.ttlSeconds,
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
    };
  };

  app.get<{ Params: { name: string } }>(
    '/.well-known/oauth-protected-resource/mcp-oauth/:name',
    (req) => ({
      resource: `${origin(req)}/mcp-oauth/${req.params.name}`,
      authorization_servers: [`${origin(req)}/oauth`],
      scopes_supported: ['mcp'],
    }),
  );
  app.get('/.well-known/oauth-authorization-server/oauth', (req) => ({
    issuer: `${origin(req)}/oauth`,
    authorization_endpoint: `${origin(req)}/oauth/authorize`,
    token_endpoint: `${origin(req)}/oauth/token`,
    grant_types_supported: ['client_credentials', 'authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    code_challenge_methods_supported: ['S256'],
    response_types_supported: ['code'],
  }));

  // Approves at once and sends the browser back with a code.
  app.get<{
    Querystring: Record<string, string | undefined>;
  }>('/oauth/authorize', (req, reply) => {
    const q = req.query;
    if (q.client_id !== MOCK_OAUTH_CLIENT.clientId || q.response_type !== 'code')
      return reply.status(400).send({ error: 'invalid_request' });
    if (q.code_challenge_method !== 'S256' || !q.code_challenge || !q.redirect_uri)
      return reply
        .status(400)
        .send({ error: 'invalid_request', error_description: 'PKCE S256 required' });
    const code = `code-${randomBytes(8).toString('hex')}`;
    oauth.codes.set(code, {
      challenge: q.code_challenge,
      redirectUri: q.redirect_uri,
      resource: q.resource ?? '',
    });
    const target = new URL(q.redirect_uri);
    target.searchParams.set('code', code);
    if (q.state) target.searchParams.set('state', q.state);
    return reply.redirect(target.toString(), 302);
  });

  app.post<{ Body: Record<string, string | undefined> }>('/oauth/token', (req, reply) => {
    const body = req.body;
    // Client authentication: HTTP Basic or the form fields.
    let clientId = body.client_id;
    let clientSecret = body.client_secret;
    const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
    if (basic?.[1]) {
      const [id, secret] = Buffer.from(basic[1], 'base64').toString().split(':');
      clientId = decodeURIComponent(id ?? '');
      clientSecret = decodeURIComponent(secret ?? '');
    }
    if (clientId !== MOCK_OAUTH_CLIENT.clientId || clientSecret !== MOCK_OAUTH_CLIENT.clientSecret)
      return reply.status(401).send({ error: 'invalid_client' });
    const resource = body.resource ?? '';
    if (!resource) return reply.status(400).send({ error: 'invalid_target' });
    switch (body.grant_type) {
      case 'client_credentials':
        oauth.stats.client_credentials++;
        return issue(resource, oauth.refreshWithClientCredentials);
      case 'authorization_code': {
        const code = oauth.codes.get(body.code ?? '');
        oauth.codes.delete(body.code ?? '');
        const challenge = createHash('sha256')
          .update(body.code_verifier ?? '')
          .digest('base64url');
        if (!code || code.challenge !== challenge || code.redirectUri !== body.redirect_uri)
          return reply.status(400).send({ error: 'invalid_grant' });
        oauth.stats.authorization_code++;
        return issue(resource, true);
      }
      case 'refresh_token': {
        const old = oauth.refresh.get(body.refresh_token ?? '');
        // Rotation: a refresh token works once.
        if (!old) return reply.status(400).send({ error: 'invalid_grant' });
        oauth.refresh.delete(body.refresh_token ?? '');
        oauth.stats.refresh_token++;
        return issue(old.resource, true);
      }
      default:
        return reply.status(400).send({ error: 'unsupported_grant_type' });
    }
  });

  app.post<{ Params: { name: string }; Body: Rpc }>('/mcp-oauth/:name', async (req, reply) => {
    const resource = `${origin(req)}/mcp-oauth/${req.params.name}`;
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    const grant = oauth.access.get(token);
    if (!grant || grant.expiresAt <= Date.now() || grant.resource !== resource) {
      oauth.stats.rejected++;
      return reply
        .status(401)
        .header(
          'www-authenticate',
          `Bearer resource_metadata="${origin(req)}/.well-known/oauth-protected-resource/mcp-oauth/${req.params.name}"`,
        )
        .send({ error: 'invalid_token' });
    }
    return streamable(req, reply);
  });

  app.post<{ Body: { ttlSeconds?: number; refreshWithClientCredentials?: boolean } }>(
    '/__oauth/config',
    (req) => {
      if (typeof req.body.ttlSeconds === 'number') oauth.ttlSeconds = req.body.ttlSeconds;
      if (typeof req.body.refreshWithClientCredentials === 'boolean')
        oauth.refreshWithClientCredentials = req.body.refreshWithClientCredentials;
      return { ok: true };
    },
  );
  app.post('/__oauth/revoke', () => {
    oauth.access.clear();
    return { ok: true };
  });
  app.get('/__oauth/stats', () => oauth.stats);

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

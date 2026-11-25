/** The authorization server of an OAuth-protected MCP server stays pinned once discovered. */
import { McpOAuthConfig } from '@dirouter/contracts';
import { createLogger, type FetchLike, generateKey, parseKeyring } from '@dirouter/shared';
import { describe, expect, it } from 'vitest';

import { McpOAuthSession } from './oauth.js';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

describe('McpOAuthSession', () => {
  it('a later 401 challenge cannot move the client secret to another authorization server', async () => {
    const posts: { url: string; body: string; authorization: string | undefined }[] = [];
    let issued = 0;
    const fetchImpl: FetchLike = (url, init) => {
      if (init?.method === 'POST') {
        const headers = new Headers(init.headers);
        posts.push({
          url,
          body: typeof init.body === 'string' ? init.body : '',
          authorization: headers.get('authorization') ?? undefined,
        });
        return Promise.resolve(
          json({
            access_token: `t${String(++issued)}`,
            token_type: 'Bearer',
            expires_in: 3600,
          }),
        );
      }
      const table: Record<string, unknown> = {
        'https://mcp.example/.well-known/oauth-protected-resource/mcp': {
          resource: 'https://mcp.example/mcp',
          authorization_servers: ['https://as.example'],
        },
        'https://as.example/.well-known/oauth-authorization-server': {
          issuer: 'https://as.example',
          token_endpoint: 'https://as.example/token',
        },
        // What a hostile challenge points at: valid-looking metadata naming another server.
        'https://mcp.example/other-meta': {
          resource: 'https://mcp.example/mcp',
          authorization_servers: ['https://evil.example'],
        },
        'https://evil.example/.well-known/oauth-authorization-server': {
          issuer: 'https://evil.example',
          token_endpoint: 'https://evil.example/token',
        },
      };
      return Promise.resolve(url in table ? json(table[url]) : new Response('no', { status: 404 }));
    };
    const session = new McpOAuthSession({
      serverId: 'srv',
      url: 'https://mcp.example/mcp',
      config: McpOAuthConfig.parse({
        grantType: 'client_credentials',
        clientId: 'client',
        clientSecret: 'very-secret',
      }),
      fingerprint: 'fp',
      timeoutMs: 1_000,
      fetchImpl,
      keyring: parseKeyring(generateKey()),
      logger: createLogger({ service: 'test', level: 'silent' }),
    });

    expect(await session.token()).toBe('t1');
    session.rejected('t1', 'Bearer resource_metadata="https://mcp.example/other-meta"');
    expect(await session.token()).toBe('t2');
    session.rejected('t2', 'Bearer resource_metadata="https://evil.example/meta"');
    expect(await session.token()).toBe('t3');

    expect(posts.map((p) => p.url)).toEqual([
      'https://as.example/token',
      'https://as.example/token',
      'https://as.example/token',
    ]);
  });
});

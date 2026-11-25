import { describe, expect, it } from 'vitest';

import {
  clientAuthMethod,
  discoverOAuth,
  type FetchLike,
  OAuthError,
  requestToken,
  resourceMetadataFromChallenge,
  wellKnownUrl,
} from './oauth-client.js';

/** A fetch answering from a table of URL → JSON; anything else is a 404. */
const fakeFetch =
  (table: Record<string, unknown>, seen: string[] = []): FetchLike =>
  (url) => {
    seen.push(url);
    return Promise.resolve(
      url in table
        ? new Response(JSON.stringify(table[url]), {
            headers: { 'content-type': 'application/json' },
          })
        : new Response('no', { status: 404 }),
    );
  };

describe('OAuth client helpers (card 28.1)', () => {
  it('builds well-known URLs with path insertion', () => {
    expect(wellKnownUrl('https://h.example/mcp/a/', 'oauth-protected-resource')).toBe(
      'https://h.example/.well-known/oauth-protected-resource/mcp/a',
    );
    expect(wellKnownUrl('https://as.example', 'oauth-authorization-server')).toBe(
      'https://as.example/.well-known/oauth-authorization-server',
    );
  });

  it('reads resource_metadata from a challenge', () => {
    expect(
      resourceMetadataFromChallenge(
        'Bearer error="invalid_token", resource_metadata="https://h/.well-known/oauth-protected-resource"',
      ),
    ).toBe('https://h/.well-known/oauth-protected-resource');
    expect(resourceMetadataFromChallenge('Bearer resource_metadata=https://h/x, scope="a"')).toBe(
      'https://h/x',
    );
    expect(resourceMetadataFromChallenge('Basic realm="x"')).toBeUndefined();
  });

  it('discovers through the challenge hint, then the authorization server with OpenID fallback', async () => {
    const seen: string[] = [];
    const found = await discoverOAuth(
      'https://mcp.example/v1',
      {},
      {
        hint: '/meta',
        fetchImpl: fakeFetch(
          {
            'https://mcp.example/meta': {
              resource: 'https://mcp.example/v1',
              authorization_servers: ['https://as.example/tenant'],
            },
            'https://as.example/.well-known/openid-configuration/tenant': {
              issuer: 'https://as.example/tenant',
              token_endpoint: 'https://as.example/tenant/token',
            },
          },
          seen,
        ),
      },
    );
    expect(found).toEqual({
      resource: 'https://mcp.example/v1',
      server: {
        issuer: 'https://as.example/tenant',
        token_endpoint: 'https://as.example/tenant/token',
      },
    });
    expect(seen).toEqual([
      'https://mcp.example/meta',
      'https://as.example/.well-known/oauth-authorization-server/tenant',
      'https://as.example/.well-known/openid-configuration/tenant',
    ]);
  });

  it('refuses metadata naming another issuer, and skips discovery for a given endpoint', async () => {
    await expect(
      discoverOAuth(
        'https://mcp.example',
        { issuer: 'https://as.example' },
        {
          fetchImpl: fakeFetch({
            'https://as.example/.well-known/oauth-authorization-server': {
              issuer: 'https://evil.example',
              token_endpoint: 'https://evil.example/token',
            },
          }),
        },
      ),
    ).rejects.toBeInstanceOf(OAuthError);
    expect(
      await discoverOAuth('https://mcp.example', { tokenEndpoint: 'https://as.example/t' }, {}),
    ).toEqual({
      resource: 'https://mcp.example',
      server: { token_endpoint: 'https://as.example/t' },
    });
  });

  it('chooses the client authentication method and reports token errors', async () => {
    const server = { token_endpoint: 'https://as.example/token' };
    expect(clientAuthMethod({ clientId: 'c', clientSecret: 's' }, server)).toBe(
      'client_secret_basic',
    );
    expect(
      clientAuthMethod(
        { clientId: 'c', clientSecret: 's' },
        { ...server, token_endpoint_auth_methods_supported: ['client_secret_post'] },
      ),
    ).toBe('client_secret_post');
    expect(clientAuthMethod({ clientId: 'c' }, server)).toBe('none');

    let sent: RequestInit | undefined;
    const fetchImpl: FetchLike = (_url, init) => {
      sent = init;
      return Promise.resolve(
        new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 }),
      );
    };
    const error = await requestToken(
      server,
      { clientId: 'a b', clientSecret: 's:1' },
      { grant_type: 'client_credentials', resource: 'https://mcp.example', scope: undefined },
      { fetchImpl },
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ error: 'invalid_client', status: 401 });
    expect((sent?.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from('a+b:s%3A1').toString('base64')}`,
    );
    expect(sent?.body).toBe('grant_type=client_credentials&resource=https%3A%2F%2Fmcp.example');
  });
});

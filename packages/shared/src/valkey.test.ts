/** Valkey connection targets: plain URL and Sentinel (card 17.3). */
import { describe, expect, it } from 'vitest';

import { connectValkey, parseValkeyUrl } from './valkey.js';

describe('parseValkeyUrl', () => {
  it('handles IPv6 sentinels, query strings and TLS', () => {
    expect(parseValkeyUrl('redis+sentinel://[::1]:26380,[fd00::2]/dirouter/1?timeout=5')).toEqual({
      kind: 'sentinel',
      options: {
        sentinels: [
          { host: '::1', port: 26_380 },
          { host: 'fd00::2', port: 26_379 },
        ],
        name: 'dirouter',
        db: 1,
      },
    });
    const secure = parseValkeyUrl('rediss+sentinel://s1:26379/dirouter');
    expect(secure.kind === 'sentinel' && secure.options).toMatchObject({
      tls: {},
      sentinelTLS: {},
      enableTLSForSentinelMode: true,
    });
  });

  it('passes ordinary URLs through untouched', () => {
    expect(parseValkeyUrl('redis://valkey:6379')).toEqual({
      kind: 'url',
      url: 'redis://valkey:6379',
    });
    expect(parseValkeyUrl('rediss://:pw@cache.example.com:6380/2')).toEqual({
      kind: 'url',
      url: 'rediss://:pw@cache.example.com:6380/2',
    });
  });

  it('parses sentinel hosts, primary name, password and database', () => {
    expect(parseValkeyUrl('redis+sentinel://:s3cr%40t@s1:26379,s2:26380,s3/mymaster/3')).toEqual({
      kind: 'sentinel',
      options: {
        sentinels: [
          { host: 's1', port: 26_379 },
          { host: 's2', port: 26_380 },
          { host: 's3', port: 26_379 },
        ],
        name: 'mymaster',
        password: 's3cr@t',
        db: 3,
      },
    });
    expect(parseValkeyUrl('redis+sentinel://user:pw@s1:26379/dirouter')).toEqual({
      kind: 'sentinel',
      options: {
        sentinels: [{ host: 's1', port: 26_379 }],
        name: 'dirouter',
        password: 'pw',
        username: 'user',
      },
    });
  });

  it('rejects incomplete sentinel addresses with a clear message', () => {
    expect(() => parseValkeyUrl('redis+sentinel://s1:26379')).toThrow('primary name');
    expect(() => parseValkeyUrl('redis+sentinel:///mymaster')).toThrow('no sentinel hosts');
    expect(() => parseValkeyUrl('redis+sentinel://s1:notaport/mymaster')).toThrow(
      'invalid sentinel address',
    );
    expect(() => parseValkeyUrl('redis+sentinel://s1:26379/mymaster/x')).toThrow(
      'invalid database index',
    );
  });
});

describe('connectValkey', () => {
  class FakeClient {
    readonly args: unknown[];
    constructor(...args: unknown[]) {
      this.args = args;
    }
  }

  it('uses (url, options) for a plain URL', () => {
    const client = connectValkey(FakeClient, 'redis://valkey:6379', { maxRetriesPerRequest: 1 });
    expect(client.args).toEqual(['redis://valkey:6379', { maxRetriesPerRequest: 1 }]);
  });

  it('merges sentinel settings with the caller options, caller wins', () => {
    const client = connectValkey(FakeClient, 'redis+sentinel://:pw@s1:26379/mymaster', {
      enableOfflineQueue: false,
      password: 'override',
    });
    expect(client.args).toEqual([
      {
        sentinels: [{ host: 's1', port: 26_379 }],
        name: 'mymaster',
        enableOfflineQueue: false,
        password: 'override',
      },
    ]);
  });
});

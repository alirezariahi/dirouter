/** SSO rules (card 14.2): roles, email domains, outbound URLs and the redirect URI. */
import { describe, expect, it } from 'vitest';

import {
  assertOutboundUrlAllowed,
  assertSsoRolesAllowed,
  emailDomainAllowed,
  isBlockedAddress,
  normalizeAllowedDomains,
  parseOutboundUrl,
  resolveRedirectUri,
  resolveSsoRole,
  ssoRoleForExistingMember,
} from './sso-policy.js';

describe('role mapping', () => {
  const map = { admins: 'ADMIN', staff: 'MEMBER', owners: 'OWNER', junk: 'ROOT' };

  it('picks the highest mapped role and reports whether a mapping matched', () => {
    expect(resolveSsoRole(map, ['staff', 'admins'], 'VIEWER')).toEqual({
      role: 'ADMIN',
      matched: true,
    });
    expect(resolveSsoRole(map, ['unknown', 'junk'], 'VIEWER')).toEqual({
      role: 'VIEWER',
      matched: false,
    });
  });

  it('never yields OWNER, neither from a mapping nor from a stored default', () => {
    expect(resolveSsoRole(map, ['owners'], 'VIEWER')).toEqual({ role: 'VIEWER', matched: false });
    expect(resolveSsoRole(map, ['owners', 'staff'], 'VIEWER').role).toBe('MEMBER');
    expect(resolveSsoRole({}, [], 'OWNER')).toEqual({ role: 'MEMBER', matched: false });
    // Inherited object keys are not mappings.
    expect(resolveSsoRole({}, ['constructor', 'toString'], 'VIEWER').matched).toBe(false);
  });

  it('raises an existing member only through an explicit mapping, never by the default role', () => {
    expect(ssoRoleForExistingMember('VIEWER', { role: 'ADMIN', matched: false })).toBe('VIEWER');
    expect(ssoRoleForExistingMember('VIEWER', { role: 'ADMIN', matched: true })).toBe('ADMIN');
    expect(ssoRoleForExistingMember('ADMIN', { role: 'MEMBER', matched: true })).toBe('ADMIN');
    expect(ssoRoleForExistingMember('OWNER', { role: 'VIEWER', matched: true })).toBe('OWNER');
    expect(ssoRoleForExistingMember('ADMIN', { role: 'OWNER', matched: true })).toBe('ADMIN');
  });

  it('rejects OWNER and roles above the editor in a connection', () => {
    expect(() => {
      assertSsoRolesAllowed('OWNER', { defaultRole: 'MEMBER', groupRoleMap: { a: 'ADMIN' } });
    }).not.toThrow();
    expect(() => {
      assertSsoRolesAllowed('OWNER', { defaultRole: 'OWNER' });
    }).toThrow('OWNER');
    expect(() => {
      assertSsoRolesAllowed('OWNER', { groupRoleMap: { a: 'OWNER' } });
    }).toThrow('groupRoleMap.a');
    expect(() => {
      assertSsoRolesAllowed('MEMBER', { groupRoleMap: { a: 'ADMIN' } });
    }).toThrow('above your own');
    expect(() => {
      assertSsoRolesAllowed('VIEWER', { defaultRole: 'MEMBER' });
    }).toThrow('above your own');
    expect(() => {
      assertSsoRolesAllowed('MEMBER', { defaultRole: 'MEMBER' });
    }).not.toThrow();
  });
});

describe('allowed domains', () => {
  it('requires at least one valid domain and normalizes the list', () => {
    expect(normalizeAllowedDomains([' Example.COM ', 'example.com', 'sub.example.org'])).toEqual([
      'example.com',
      'sub.example.org',
    ]);
    expect(() => normalizeAllowedDomains([])).toThrow('at least one');
    expect(() => normalizeAllowedDomains(undefined)).toThrow('at least one');
    expect(() => normalizeAllowedDomains(['*'])).toThrow('Invalid');
    expect(() => normalizeAllowedDomains(['example'])).toThrow('Invalid');
  });

  it('matches the email domain exactly; an empty list allows nothing', () => {
    expect(emailDomainAllowed('a@example.com', ['example.com'])).toBe(true);
    expect(emailDomainAllowed('a@EXAMPLE.com', ['example.com'])).toBe(true);
    expect(emailDomainAllowed('a@evil-example.com', ['example.com'])).toBe(false);
    expect(emailDomainAllowed('a@sub.example.com', ['example.com'])).toBe(false);
    expect(emailDomainAllowed('"a@example.com"@evil.org', ['example.com'])).toBe(false);
    expect(emailDomainAllowed('a@example.com', [])).toBe(false);
    expect(emailDomainAllowed('example.com', ['example.com'])).toBe(false);
  });
});

describe('outbound URLs', () => {
  it('blocks loopback, private, link-local and other reserved addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      '::',
      'fe80::1',
      'fd00::1',
      '::ffff:10.0.0.1',
      '::ffff:127.0.0.1',
      'not-an-ip',
    ])
      expect(isBlockedAddress(address), address).toBe(true);
    for (const address of ['8.8.8.8', '172.32.0.1', '2001:4860:4860::8888', '::ffff:8.8.8.8'])
      expect(isBlockedAddress(address), address).toBe(false);
  });

  it('requires https in production and allows http only in development', () => {
    expect(() => parseOutboundUrl('http://sso.example.com', true)).toThrow('https');
    expect(parseOutboundUrl('http://sso.localhost/realms/x', false).hostname).toBe('sso.localhost');
    expect(() => parseOutboundUrl('file:///etc/passwd', false)).toThrow('https');
    expect(() => parseOutboundUrl('javascript:alert(1)', false)).toThrow('https');
    expect(() => parseOutboundUrl('https://user:pw@sso.example.com', true)).toThrow('credentials');
    expect(() => parseOutboundUrl('nonsense', true)).toThrow('valid URL');
  });

  it('rejects hosts that resolve to a private address in production', async () => {
    const resolver = (addresses: string[]) => () => Promise.resolve(addresses);
    await expect(
      assertOutboundUrlAllowed('https://sso.example.com', true, resolver(['93.184.216.34'])),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      assertOutboundUrlAllowed('https://sso.example.com', true, resolver(['10.0.0.5'])),
    ).rejects.toThrow('public address');
    // One private answer among public ones is enough to refuse.
    await expect(
      assertOutboundUrlAllowed('https://x.example.com', true, resolver(['93.184.216.34', '::1'])),
    ).rejects.toThrow('public address');
    await expect(
      assertOutboundUrlAllowed('https://x.example.com', true, resolver([])),
    ).rejects.toThrow('public address');
    await expect(
      assertOutboundUrlAllowed('https://x.example.com', true, () => Promise.reject(new Error('x'))),
    ).rejects.toThrow('public address');
    await expect(assertOutboundUrlAllowed('https://169.254.169.254/latest', true)).rejects.toThrow(
      'public address',
    );
    await expect(assertOutboundUrlAllowed('https://[::1]:8443/', true)).rejects.toThrow(
      'public address',
    );
  });

  it('keeps a local development provider working outside production', async () => {
    await expect(
      assertOutboundUrlAllowed('http://sso.localhost/realms/dirouter', false, () =>
        Promise.resolve(['127.0.0.1']),
      ),
    ).resolves.toBeInstanceOf(URL);
  });
});

describe('redirect URI', () => {
  const dashboard = 'https://app.example.com/';

  it('is derived from the configured dashboard URL', () => {
    expect(resolveRedirectUri(dashboard, undefined, true)).toBe('https://app.example.com/login');
    expect(resolveRedirectUri(dashboard, 'https://app.example.com/login', true)).toBe(
      'https://app.example.com/login',
    );
  });

  it('rejects any other caller-supplied value', () => {
    expect(() => resolveRedirectUri(dashboard, 'https://evil.example/login', true)).toThrow(
      'does not match',
    );
    expect(() => resolveRedirectUri(dashboard, 'https://app.example.com/other', true)).toThrow(
      'does not match',
    );
    expect(() => resolveRedirectUri(dashboard, 'http://app.example.com/login', true)).toThrow(
      'does not match',
    );
    expect(() => resolveRedirectUri(dashboard, 'https://evil.example/login', false)).toThrow(
      'does not match',
    );
  });

  it('tolerates only a scheme difference in development', () => {
    expect(resolveRedirectUri('https://app.localhost', 'http://app.localhost/login', false)).toBe(
      'http://app.localhost/login',
    );
  });
});

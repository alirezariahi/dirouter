/** Privilege-escalation rules for members and custom roles (card 14.3). */
import { describe, expect, it } from 'vitest';

import {
  canManageMember,
  effectivePermissions,
  missingPermissions,
  PERMISSIONS,
} from './permissions.js';

describe('effectivePermissions / missingPermissions', () => {
  it('is the union of the base role and the custom role', () => {
    const held = effectivePermissions('VIEWER', ['security:write']);
    expect(held.has('org:read')).toBe(true);
    expect(held.has('security:write')).toBe(true);
    expect(held.has('members:write')).toBe(false);
  });

  it('reports every requested permission the holder lacks', () => {
    const held = effectivePermissions('MEMBER', ['security:write']);
    expect(missingPermissions(held, ['keys:write', 'security:write'])).toEqual([]);
    expect(missingPermissions(held, ['providers:write', 'org:read', 'providers:write'])).toEqual([
      'providers:write',
    ]);
    expect(missingPermissions(effectivePermissions('ADMIN'), [...PERMISSIONS])).toEqual([]);
  });
});

describe('canManageMember', () => {
  it('refuses a target with a higher base role', () => {
    expect(canManageMember({ role: 'ADMIN' }, { role: 'OWNER' })).toBe(false);
    expect(
      canManageMember({ role: 'MEMBER', customPermissions: ['members:write'] }, { role: 'ADMIN' }),
    ).toBe(false);
  });

  it('allows equal or lower members', () => {
    expect(canManageMember({ role: 'ADMIN' }, { role: 'ADMIN' })).toBe(true);
    expect(canManageMember({ role: 'OWNER' }, { role: 'ADMIN' })).toBe(true);
    expect(
      canManageMember({ role: 'MEMBER', customPermissions: ['members:write'] }, { role: 'VIEWER' }),
    ).toBe(true);
  });

  it('refuses a same-rank target whose custom role grants more than the actor holds', () => {
    const actor = { role: 'MEMBER', customPermissions: ['members:write'] } as const;
    expect(canManageMember(actor, { role: 'MEMBER', customPermissions: ['security:write'] })).toBe(
      false,
    );
    expect(canManageMember(actor, { role: 'VIEWER', customPermissions: ['providers:write'] })).toBe(
      false,
    );
    expect(canManageMember(actor, { role: 'MEMBER', customPermissions: ['members:write'] })).toBe(
      true,
    );
  });
});

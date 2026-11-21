/** Mandatory MFA per role (card 14.1): which memberships the organization policy covers. */
import { describe, expect, it } from 'vitest';

import { mfaPolicyApplies, secondFactorSatisfied } from './permissions.js';

describe('mfaPolicyApplies', () => {
  const org = (
    mfaRequiredRoles: string[],
    passwordLoginDisabled = false,
    hasEnabledSso = false,
  ) => ({
    mfaRequiredRoles,
    passwordLoginDisabled,
    hasEnabledSso,
  });

  it('covers exactly the configured roles', () => {
    expect(mfaPolicyApplies('OWNER', org(['OWNER', 'ADMIN']))).toBe(true);
    expect(mfaPolicyApplies('ADMIN', org(['OWNER', 'ADMIN']))).toBe(true);
    expect(mfaPolicyApplies('MEMBER', org(['OWNER', 'ADMIN']))).toBe(false);
    expect(mfaPolicyApplies('VIEWER', org([]))).toBe(false);
  });

  it('is delegated to the identity provider in SSO-only organizations', () => {
    expect(mfaPolicyApplies('OWNER', org(['OWNER'], true, true))).toBe(false);
  });

  it('still applies when password login is disabled but no SSO connection is enabled', () => {
    // Password login works again in that state, so the policy must not be switched off by the flag.
    expect(mfaPolicyApplies('OWNER', org(['OWNER'], true, false))).toBe(true);
    expect(mfaPolicyApplies('OWNER', org(['OWNER'], false, true))).toBe(true);
  });
});

describe('secondFactorSatisfied', () => {
  it('needs TOTP for password sessions; a merely registered passkey is not asked at login', () => {
    expect(secondFactorSatisfied('pwd', false)).toBe(false);
    expect(secondFactorSatisfied('pwd', true)).toBe(true);
  });

  it('accepts sessions opened with a passkey or through the organization identity provider', () => {
    expect(secondFactorSatisfied('passkey', false)).toBe(true);
    expect(secondFactorSatisfied('sso', false)).toBe(true);
  });
});

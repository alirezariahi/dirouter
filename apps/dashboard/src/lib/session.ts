/**
 * Dashboard user session (card 7.2): restored from the refresh cookie on startup, sign-in, setup and sign-out.
 * The current organization is the first membership (organization selection in 7.9).
 */
import { useSyncExternalStore } from 'react';

import { api, setAccessToken } from './api';
import { passkeyAssertion } from './webauthn';

export type Role = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  organizations: {
    id: string;
    name: string;
    slug: string;
    role: Role;
    /**
     * Effective permissions (base role plus custom role). `/auth/me` does not send this yet; when
     * it does, `can` uses it instead of the base-role matrix below.
     */
    permissions?: string[];
    /** The operator's own organization; only it sees the billing pages (card 25.1). */
    isPlatform?: boolean;
  }[];
}

let user: SessionUser | undefined;
let restored: Promise<SessionUser | undefined> | undefined;
const subs = new Set<() => void>();
const emit = () => {
  for (const s of subs) s();
};

const ACTIVE_ORG_KEY = 'dirouter.org';
let activeOrgId: string | undefined = (() => {
  try {
    return localStorage.getItem(ACTIVE_ORG_KEY) ?? undefined;
  } catch {
    return undefined;
  }
})();

export const getUser = () => user;
/** The selected organization when the user is still a member of it, otherwise the first one. */
export const currentOrg = () =>
  user?.organizations.find((o) => o.id === activeOrgId) ?? user?.organizations[0];

export function setActiveOrg(id: string | undefined) {
  activeOrgId = id;
  try {
    if (id) localStorage.setItem(ACTIVE_ORG_KEY, id);
    else localStorage.removeItem(ACTIVE_ORG_KEY);
  } catch {
    // the selection only lasts for this page load.
  }
  emit();
}

type Org = SessionUser['organizations'][number];
/** What MEMBER may write (mirrors ROLE_PERMISSIONS in control-api rbac/permissions.ts). */
const MEMBER_WRITES = ['projects:write', 'keys:write'];

/**
 * Whether the membership holds a permission. Uses the effective permission list when the API
 * provides one; otherwise falls back to the base role, which under-reports for members whose
 * custom role adds permissions (the server stays the authority either way).
 */
export function can(org: Pick<Org, 'role' | 'permissions'> | undefined, permission: string) {
  if (!org) return false;
  if (org.permissions) return org.permissions.includes(permission);
  if (org.role === 'OWNER' || org.role === 'ADMIN') return true;
  if (permission.endsWith(':read')) return true;
  return org.role === 'MEMBER' && MEMBER_WRITES.includes(permission);
}

export function useSession() {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => user,
  );
}

async function loadMe() {
  user = await api<SessionUser>('/auth/me');
  emit();
  return user;
}

/** Once on startup: the session is returned if the refresh cookie is valid. */
export function restoreSession(): Promise<SessionUser | undefined> {
  restored ??= api<{ accessToken: string }>('/auth/refresh', { method: 'POST' })
    .then((r) => {
      setAccessToken(r.accessToken);
      return loadMe();
    })
    .catch(() => undefined);
  return restored;
}

export async function setupRequired(): Promise<boolean> {
  return (await api<{ required: boolean }>('/auth/setup')).required;
}

export async function login(email: string, password: string, mfaCode?: string) {
  const r = await api<{ accessToken: string }>('/auth/login', {
    method: 'POST',
    body: { email, password, ...(mfaCode ? { mfaCode } : {}) },
  });
  return signedIn(r.accessToken);
}

async function signedIn(accessToken: string) {
  setAccessToken(accessToken);
  restored = Promise.resolve(await loadMe());
  return user;
}

const SSO_STATE_KEY = 'dirouter.sso.state';
const ssoStore = {
  set: (state: string) => {
    try {
      sessionStorage.setItem(SSO_STATE_KEY, state);
    } catch {
      // without sessionStorage the return leg is refused (see ssoComplete).
    }
  },
  take: (): string | undefined => {
    try {
      const state = sessionStorage.getItem(SSO_STATE_KEY) ?? undefined;
      sessionStorage.removeItem(SSO_STATE_KEY);
      return state;
    } catch {
      return undefined;
    }
  },
};

/** The `state` that came back does not belong to a sign-in this browser tab started. */
export class SsoStateError extends Error {
  constructor() {
    super('SSO state mismatch');
  }
}

/**
 * Single sign-on (card 14.2). `ssoStart` returns the identity provider URL for the organization
 * that owns the email's domain, or undefined when no SSO connection applies. The server derives
 * the redirect URI itself (`<PUBLIC_DASHBOARD_URL>/login`) and binds `state` to an HttpOnly cookie;
 * both calls send credentials like every other request of this client. The state is also kept in
 * sessionStorage so a `?code=&state=` this tab never asked for is refused before it is exchanged
 * (defence in depth against login CSRF).
 */
export async function ssoStart(email: string): Promise<string | undefined> {
  const connection = await api<{ connectionId: string } | null>('/auth/sso/lookup', {
    method: 'POST',
    body: { email },
  });
  if (!connection) return undefined;
  const started = await api<{ authorizationUrl: string; state: string }>(
    `/auth/sso/${encodeURIComponent(connection.connectionId)}/start`,
    { method: 'POST', body: {} },
  );
  ssoStore.set(started.state);
  return started.authorizationUrl;
}

export async function ssoComplete(code: string, state: string) {
  const expected = ssoStore.take();
  if (!expected || expected !== state) throw new SsoStateError();
  const r = await api<{ accessToken: string; organizationId?: string }>('/auth/sso/callback', {
    query: { code, state },
  });
  // An SSO session is only valid inside the organization whose identity provider vouched for it.
  if (r.organizationId) setActiveOrg(r.organizationId);
  return signedIn(r.accessToken);
}

/** Passkey sign-in; `email` narrows the prompt to that account's passkeys when given. */
export async function passkeyLogin(email?: string) {
  return signedIn((await passkeyAssertion(email)).accessToken);
}

/**
 * Accepts an invitation. A new account sends `name`; an existing account sends its own password
 * and, when the server answers `mfa_required`, the second factor as well.
 */
export async function acceptInvitation(input: {
  token: string;
  password: string;
  name?: string;
  mfaCode?: string;
}) {
  const r = await api<{ accessToken: string }>('/auth/invitations/accept', {
    method: 'POST',
    body: input,
  });
  return signedIn(r.accessToken);
}

export async function setup(input: {
  organizationName: string;
  name: string;
  email: string;
  password: string;
}) {
  const r = await api<{ accessToken: string }>('/auth/setup', { method: 'POST', body: input });
  return signedIn(r.accessToken);
}

export async function logout() {
  await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
  setAccessToken(undefined);
  user = undefined;
  restored = Promise.resolve(undefined);
  emit();
}

export async function changePassword(currentPassword: string, newPassword: string) {
  await api('/auth/password', { method: 'POST', body: { currentPassword, newPassword } });
  // all sessions were revoked; sign in again with the new password.
  await logout();
}

/** For tests only. */
export function resetSessionForTests() {
  user = undefined;
  restored = undefined;
  activeOrgId = undefined;
  setAccessToken(undefined);
  emit();
}

/**
 * The signed-in user and their workspace (the organization the portal created for them, or the
 * first one they belong to).
 */
import { api, refresh, setAccessToken, signedIn } from './api';

export interface Me {
  id: string;
  email: string;
  name: string;
  organizations: { id: string; name: string; role: string }[];
}

export interface SessionResponse {
  accessToken: string;
}

let current: Me | undefined;

/** The session from the refresh cookie; any failure means signed out, never a stale user. */
export async function restore(): Promise<Me | undefined> {
  try {
    if (!signedIn() && !(await refresh())) throw new Error('signed out');
    current = await api<Me>('/auth/me');
  } catch {
    current = undefined;
    setAccessToken(undefined);
  }
  return current;
}

export async function start(session: SessionResponse): Promise<Me> {
  setAccessToken(session.accessToken);
  current = await api<Me>('/auth/me');
  return current;
}

export async function signOut() {
  await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
  current = undefined;
  setAccessToken(undefined);
}

export const me = () => current;
export const orgId = () => current?.organizations[0]?.id ?? '';

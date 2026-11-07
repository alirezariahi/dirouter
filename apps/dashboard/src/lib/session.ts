/**
 * نشست کاربر داشبورد (کارت ۷.۲): بازیابی با refresh کوکی در شروع، ورود، راه‌اندازی، خروج.
 * سازمان فعلی اولین عضویت است (انتخاب سازمان در ۷.۹).
 */
import { useSyncExternalStore } from 'react';

import { api, setAccessToken } from './api';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  organizations: {
    id: string;
    name: string;
    slug: string;
    role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';
  }[];
}

let user: SessionUser | undefined;
let restored: Promise<SessionUser | undefined> | undefined;
const subs = new Set<() => void>();
const emit = () => {
  for (const s of subs) s();
};

export const getUser = () => user;
export const currentOrg = () => user?.organizations[0];

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

/** یک بار در شروع: اگر کوکی refresh معتبر باشد نشست برمی‌گردد. */
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

export async function login(email: string, password: string) {
  const r = await api<{ accessToken: string }>('/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  setAccessToken(r.accessToken);
  restored = Promise.resolve(await loadMe());
  return user;
}

export async function setup(input: {
  organizationName: string;
  name: string;
  email: string;
  password: string;
}) {
  const r = await api<{ accessToken: string }>('/auth/setup', { method: 'POST', body: input });
  setAccessToken(r.accessToken);
  restored = Promise.resolve(await loadMe());
  return user;
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
  // همهٔ نشست‌ها باطل شدند؛ با رمز تازه دوباره وارد شوید.
  await logout();
}

/** فقط برای تست. */
export function resetSessionForTests() {
  user = undefined;
  restored = undefined;
  setAccessToken(undefined);
  emit();
}

/**
 * API client: the access token lives only in memory; the refresh token is an httpOnly cookie sent
 * with `credentials: 'include'`. A 401 is retried once after `/auth/refresh` (concurrent requests
 * share one refresh). Errors are problem+json and become ApiError.
 */
import { API_URL } from '../config';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

let accessToken: string | undefined;
let refreshing: Promise<boolean> | undefined;
const listeners = new Set<() => void>();

export function setAccessToken(token: string | undefined) {
  accessToken = token;
  for (const l of listeners) l();
}
export const onAuthChange = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
export const signedIn = () => accessToken !== undefined;

export function refresh(): Promise<boolean> {
  refreshing ??= fetch(`${API_URL}/auth/refresh`, { method: 'POST', credentials: 'include' })
    .then(async (res) => {
      if (!res.ok) {
        setAccessToken(undefined);
        return false;
      }
      setAccessToken(((await res.json()) as { accessToken: string }).accessToken);
      return true;
    })
    .catch(() => false)
    .finally(() => {
      refreshing = undefined;
    });
  return refreshing;
}

/** Sign-in endpoints answer 401 for a wrong password; never refresh-and-retry those. */
const NO_RETRY = /^\/(auth\/(login|refresh|logout)|portal\/)/;

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
  retried = false,
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: options.method ?? 'GET',
    credentials: 'include',
    headers: {
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  if (res.status === 401 && !retried && !NO_RETRY.test(path) && (await refresh()))
    return api<T>(path, options, true);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const problem = (body ?? {}) as { detail?: string; title?: string; code?: string };
    throw new ApiError(
      res.status,
      problem.code,
      problem.detail ?? problem.title ?? `HTTP ${String(res.status)}`,
    );
  }
  return body as T;
}

/**
 * API client (card 7.1): the access token lives only in memory (not localStorage); the refresh token is in
 * an httpOnly cookie sent with `credentials: 'include'`. A 401 response is retried once with
 * `/auth/refresh` (concurrent requests share one refresh). Errors are
 * problem+json and are converted to ApiError with a stable code.
 */
import { API_URL } from '../config';

export interface Problem {
  type?: string;
  title?: string;
  status: number;
  detail?: string;
  code?: string;
  requestId?: string;
  errors?: { path: string; message: string }[];
}

export class ApiError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.detail ?? problem.title ?? `HTTP ${String(problem.status)}`);
  }
  get status() {
    return this.problem.status;
  }
  get code() {
    return this.problem.code;
  }
}

let accessToken: string | undefined;
let refreshing: Promise<boolean> | undefined;
const listeners = new Set<(signedIn: boolean) => void>();

export function setAccessToken(token: string | undefined) {
  accessToken = token;
  for (const l of listeners) l(Boolean(token));
}
export const onAuthChange = (l: (signedIn: boolean) => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const isSignedIn = () => Boolean(accessToken);

async function refresh(fetchImpl: typeof fetch): Promise<boolean> {
  refreshing ??= fetchImpl(`${API_URL}/auth/refresh`, { method: 'POST', credentials: 'include' })
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

export interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Prepared body (e.g. JSON serialized by orval). */
  rawBody?: BodyInit;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal | null;
  /** For tests. */
  fetchImpl?: typeof fetch;
}

/** Request with automatic refresh; a failed response is converted to ApiError. */
async function request(
  path: string,
  opts: RequestOptions = {},
): Promise<{ data: unknown; res: Response }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const qs = Object.entries(opts.query ?? {}).filter(([, v]) => v !== undefined && v !== '');
  const sep = path.includes('?') ? '&' : '?';
  const url = `${API_URL}${path}${qs.length ? `${sep}${new URLSearchParams(qs.map(([k, v]) => [k, String(v)])).toString()}` : ''}`;
  const hasBody = opts.body !== undefined || opts.rawBody !== undefined;
  const send = () =>
    fetchImpl(url, {
      method: opts.method ?? 'GET',
      credentials: 'include',
      headers: {
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      ...(opts.rawBody !== undefined
        ? { body: opts.rawBody }
        : opts.body !== undefined
          ? { body: JSON.stringify(opts.body) }
          : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  let res = await send();
  if (res.status === 401 && !path.startsWith('/auth/') && (await refresh(fetchImpl)))
    res = await send();
  if (res.status === 204) return { data: undefined, res };
  const isJson = (res.headers.get('content-type') ?? '').includes('json');
  const data: unknown = isJson ? await res.json() : await res.text();
  if (!res.ok)
    throw new ApiError(isJson ? (data as Problem) : { status: res.status, detail: String(data) });
  return { data, res };
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  return (await request(path, opts)).data as T;
}

/**
 * orval-generated client mutator (fetch signature): document paths have the /api/v1 prefix and API_URL
 * already includes it. The output is `{data, status, headers}`, which the generated hooks expect.
 */
export async function orvalFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const { data, res } = await request(url.replace(/^\/api\/v1/, ''), {
    method: init.method ?? 'GET',
    ...(init.body !== undefined && init.body !== null ? { rawBody: init.body } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
  });
  return { data, status: res.status, headers: res.headers } as T;
}

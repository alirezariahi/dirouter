/**
 * API client (card 7.1): the access token lives only in memory (not localStorage); the refresh token is in
 * an httpOnly cookie sent with `credentials: 'include'`. A 401 response is retried once with
 * `/auth/refresh` (concurrent requests share one refresh); authenticated `/auth/*` calls are retried
 * too, the sign-in endpoints themselves never are (see `shouldRefresh`). Errors are
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
  /** `blob` keeps a binary answer (an invoice PDF) intact instead of reading it as text. */
  responseType?: 'blob';
}

/**
 * Endpoints that are themselves part of signing in or out. A 401 from them is an answer (wrong
 * password, expired refresh cookie, unknown passkey), never a reason to refresh and try again.
 */
const AUTH_FLOW = [
  /^\/auth\/(login|refresh|logout|setup|invitations\/accept)(\?|$)/,
  /^\/auth\/sso\//,
  /^\/auth\/webauthn\/login\//,
];

/**
 * Whether a 401 on `path` should be answered with one refresh and one retry.
 * - Outside `/auth/*` every 401 means the access token is missing or expired.
 * - Under `/auth/*` only calls that carried an access token (MFA, passkeys, password, me) are
 *   retried, and only when the server says the token itself was rejected (`unauthenticated`):
 *   a wrong current password is also a 401 and must not be sent twice.
 */
export function shouldRefresh(path: string, sentToken: boolean, code: string | undefined): boolean {
  if (!path.startsWith('/auth/')) return true;
  if (AUTH_FLOW.some((pattern) => pattern.test(path))) return false;
  return sentToken && code === 'unauthenticated';
}

async function problemCode(res: Response): Promise<string | undefined> {
  try {
    return ((await res.clone().json()) as Problem | null)?.code;
  } catch {
    return undefined;
  }
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
  let sentToken = false;
  const send = () => {
    sentToken = Boolean(accessToken);
    return fetchImpl(url, {
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
  };
  let res = await send();
  if (
    res.status === 401 &&
    shouldRefresh(
      path,
      sentToken,
      path.startsWith('/auth/') ? await problemCode(res) : undefined,
    ) &&
    (await refresh(fetchImpl))
  )
    res = await send();
  if (res.status === 204) return { data: undefined, res };
  const isJson = (res.headers.get('content-type') ?? '').includes('json');
  const data: unknown = isJson
    ? await res.json()
    : res.ok && opts.responseType === 'blob'
      ? await res.blob()
      : await res.text();
  if (!res.ok)
    throw new ApiError(isJson ? (data as Problem) : { status: res.status, detail: String(data) });
  // A sensitive change that waits for a second person's approval (card 22.2): the page asked for
  // the change, so tell the user it was queued instead of applied.
  if (res.status === 202 && data && typeof data === 'object' && 'changeRequest' in data)
    window.dispatchEvent(
      new CustomEvent(CHANGE_REQUEST_EVENT, {
        detail: data.changeRequest,
      }),
    );
  return { data, res };
}

export const CHANGE_REQUEST_EVENT = 'dirouter:change-request';

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

/**
 * A streaming GET (Server-Sent Events, card 24.4) with the same bearer token and one refresh on
 * 401 as `api`. Returns the open response; a failed one is thrown as ApiError.
 */
export async function apiStream(
  path: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const send = () =>
    fetchImpl(`${API_URL}${path}`, {
      credentials: 'include',
      headers: {
        accept: 'text/event-stream',
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      signal,
    });
  let res = await send();
  if (res.status === 401 && (await refresh(fetchImpl))) res = await send();
  if (!res.ok) {
    const problem = (await res.json().catch(() => undefined)) as Problem | undefined;
    throw new ApiError(problem ?? { status: res.status });
  }
  return res;
}

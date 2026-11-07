import { describe, expect, it, vi } from 'vitest';

import { api, ApiError, isSignedIn, setAccessToken } from './api';
import { formatDate } from './date';

describe('dates', () => {
  const d = new Date('2026-11-07T12:00:00Z');
  it('formats Persian (Jalali) and Gregorian calendars', () => {
    expect(formatDate(d, { calendar: 'persian', lang: 'fa' })).toContain('۱۴۰۵');
    expect(formatDate(d, { calendar: 'gregory', lang: 'en' })).toBe('Nov 7, 2026');
    expect(formatDate(d, { calendar: 'persian', lang: 'en' })).toContain('1405');
  });
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

describe('api client', () => {
  it('refreshes once on 401 and retries with the new token', async () => {
    setAccessToken('old');
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(401, { status: 401, code: 'unauthenticated' }))
      .mockResolvedValueOnce(json(200, { accessToken: 'new' }))
      .mockResolvedValueOnce(json(200, { ok: true }));
    await expect(api('/orgs/x', { fetchImpl })).resolves.toEqual({ ok: true });
    expect(fetchImpl.mock.calls[1]?.[0]).toMatch(/\/auth\/refresh$/);
    const retried = fetchImpl.mock.calls[2]?.[1]?.headers as Record<string, string>;
    expect(retried.authorization).toBe('Bearer new');
    expect(isSignedIn()).toBe(true);
  });

  it('signs out when the refresh fails and surfaces problem+json as ApiError', async () => {
    setAccessToken('old');
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(401, { status: 401 }))
      .mockResolvedValueOnce(json(401, { status: 401, code: 'refresh_token_reused' }))
      .mockResolvedValueOnce(
        json(403, {
          status: 403,
          code: 'forbidden',
          detail: 'Requires keys:write',
          requestId: 'req_1',
        }),
      );
    await expect(api('/orgs/x', { fetchImpl })).rejects.toBeInstanceOf(ApiError);
    expect(isSignedIn()).toBe(false);
    const error = await api('/orgs/y', { fetchImpl }).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 403, code: 'forbidden', message: 'Requires keys:write' });
  });
});

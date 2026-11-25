/** Upstream balance APIs (card 32.9). */
import type { ProviderConfig } from '@dirouter/contracts';
import { describe, expect, it } from 'vitest';

import { balanceKind, balanceRequest, parseBalance } from './balance.js';

const provider = (over: Partial<ProviderConfig>): ProviderConfig => ({
  id: 'p',
  organizationId: 'org',
  slug: 'p',
  type: 'openai-compatible',
  name: 'p',
  baseUrl: 'https://api.example.com/v1',
  enabled: true,
  options: {},
  credentials: [],
  ...over,
});

describe('balance APIs', () => {
  it('finds the kind from options.balance or the preset', () => {
    expect(balanceKind(provider({ options: { preset: 'openrouter' } }))).toBe('openrouter');
    expect(balanceKind(provider({ options: { balance: 'deepseek' } }))).toBe('deepseek');
    expect(balanceKind(provider({ options: { preset: 'deepseek', balance: 'none' } }))).toBe(
      undefined,
    );
    expect(balanceKind(provider({ options: { preset: 'groq' } }))).toBeUndefined();
    expect(balanceKind(provider({ type: 'openai', options: { preset: 'openrouter' } }))).toBe(
      undefined,
    );
  });

  it('builds the request URL of each API', () => {
    const urls = (['openrouter', 'deepseek', 'moonshot', 'siliconflow'] as const).map(
      (kind) => balanceRequest(provider({}), kind, 'k').url,
    );
    expect(urls).toEqual([
      'https://api.example.com/v1/credits',
      'https://api.example.com/user/balance',
      'https://api.example.com/v1/users/me/balance',
      'https://api.example.com/v1/user/info',
    ]);
    expect(balanceRequest(provider({}), 'openrouter', 'k').headers.authorization).toBe('Bearer k');
  });

  it('parses each answer', () => {
    expect(parseBalance('openrouter', { data: { total_credits: 25, total_usage: 7.25 } })).toEqual({
      amount: '17.75',
      currency: 'USD',
    });
    expect(
      parseBalance('deepseek', {
        balance_infos: [
          { currency: 'CNY', total_balance: '110.00' },
          { currency: 'USD', total_balance: '3.10' },
        ],
      }),
    ).toEqual({ amount: '3.1', currency: 'USD' });
    expect(
      parseBalance(
        'moonshot',
        { data: { available_balance: 49.58 } },
        { baseUrl: 'https://api.moonshot.cn/v1' },
      ),
    ).toEqual({ amount: '49.58', currency: 'CNY' });
    expect(parseBalance('siliconflow', { data: { totalBalance: '0.88' } })).toEqual({
      amount: '0.88',
      currency: 'CNY',
    });
    expect(parseBalance('openrouter', { error: 'x' })).toBeUndefined();
    expect(parseBalance('deepseek', { balance_infos: [] })).toBeUndefined();
  });
});

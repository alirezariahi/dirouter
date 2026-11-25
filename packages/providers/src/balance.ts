/**
 * Upstream account balance APIs (card 32.9). A provider uses one when `options.balance` names it
 * or its preset is one of them; `options.balance: "none"` turns the lookup off.
 *
 * | kind        | request                               | answer                                        |
 * | ----------- | ------------------------------------- | --------------------------------------------- |
 * | openrouter  | GET {base}/credits                    | data.total_credits − data.total_usage (USD)   |
 * | deepseek    | GET {origin}/user/balance             | balance_infos[].total_balance (USD preferred) |
 * | moonshot    | GET {base}/users/me/balance           | data.available_balance (CNY on .cn hosts)     |
 * | siliconflow | GET {base}/user/info                  | data.totalBalance (CNY)                       |
 */
import type { BalanceKind, ProviderConfig } from '@dirouter/contracts';

import type { UpstreamRequest } from './adapters.js';
import { presetFor } from './presets.js';

const KINDS: readonly BalanceKind[] = ['openrouter', 'deepseek', 'moonshot', 'siliconflow'];

export function balanceKind(provider: ProviderConfig): BalanceKind | undefined {
  const explicit = provider.options.balance;
  if (explicit === 'none') return undefined;
  if (typeof explicit === 'string' && (KINDS as readonly string[]).includes(explicit))
    return explicit as BalanceKind;
  const preset = provider.options.preset;
  if (
    provider.type === 'openai-compatible' &&
    typeof preset === 'string' &&
    (KINDS as readonly string[]).includes(preset)
  )
    return preset as BalanceKind;
  return undefined;
}

const trimSlash = (url: string) => url.replace(/\/+$/, '');

export function balanceRequest(
  provider: ProviderConfig,
  kind: BalanceKind,
  apiKey: string,
): UpstreamRequest {
  const base = trimSlash(provider.baseUrl);
  const url =
    kind === 'openrouter'
      ? `${base}/credits`
      : kind === 'deepseek'
        ? `${new URL(base).origin}/user/balance`
        : kind === 'moonshot'
          ? `${base}/users/me/balance`
          : `${base}/user/info`;
  return {
    url,
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${apiKey}`,
      ...(provider.type === 'openai-compatible' ? presetFor(provider).headers : {}),
    },
  };
}

export interface Balance {
  /** Decimal string with at most 8 fraction digits. */
  amount: string;
  currency: string;
}

function decimal(value: unknown): string | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  return n.toFixed(8).replace(/\.?0+$/, '') || '0';
}

const record = (value: unknown) =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

/** The balance in an answer of that API, or undefined when the answer has none. */
export function parseBalance(
  kind: BalanceKind,
  json: unknown,
  provider?: Pick<ProviderConfig, 'baseUrl'>,
): Balance | undefined {
  const body = record(json);
  if (kind === 'openrouter') {
    const data = record(body.data);
    const total = Number(data.total_credits);
    const used = Number(data.total_usage);
    if (!Number.isFinite(total) || !Number.isFinite(used)) return undefined;
    const amount = decimal(total - used);
    return amount === undefined ? undefined : { amount, currency: 'USD' };
  }
  if (kind === 'deepseek') {
    const infos = Array.isArray(body.balance_infos)
      ? (body.balance_infos as Record<string, unknown>[])
      : [];
    const info = infos.find((i) => i.currency === 'USD') ?? infos[0];
    const amount = decimal(info?.total_balance);
    const currency = typeof info?.currency === 'string' ? info.currency.toUpperCase() : 'USD';
    return amount === undefined ? undefined : { amount, currency };
  }
  if (kind === 'moonshot') {
    const amount = decimal(record(body.data).available_balance);
    const host = provider ? new URL(provider.baseUrl).hostname : '';
    return amount === undefined
      ? undefined
      : { amount, currency: host.endsWith('.cn') ? 'CNY' : 'USD' };
  }
  const data = record(body.data);
  const amount = decimal(data.totalBalance ?? data.balance);
  return amount === undefined ? undefined : { amount, currency: 'CNY' };
}

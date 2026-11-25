/**
 * Form helpers of a provider's budgets, quota windows and credential order (card 32.6). The form
 * edits one provider budget (monthly) and one budget per credential (daily); budgets on other
 * periods, set through the API, are kept.
 */
import type {
  ProviderSpendControllerGet200,
  ProviderSpendControllerSetCredentialBody,
} from '../api/generated';

export type ProviderSpend = ProviderSpendControllerGet200;
type Budget = ProviderSpend['budgets'][number];
type QuotaWindows = NonNullable<ProviderSpendControllerSetCredentialBody['quotaWindows']>;
type BudgetBody = NonNullable<ProviderSpendControllerSetCredentialBody['budgets']>[number];

const USD = /^\d{1,10}(\.\d{1,8})?$/;

/** The amount the form shows for one period, or ''. */
export const amountOf = (budgets: readonly Budget[], period: Budget['period']) =>
  budgets.find((b) => b.period === period)?.limitUsd ?? '';

/** Budgets with the form's period set to `usd` (or removed when empty); the others kept. */
export function withAmount(
  budgets: readonly Budget[],
  period: Budget['period'],
  usd: string,
): BudgetBody[] | 'invalid' {
  const value = usd.trim();
  if (value && (!USD.test(value) || Number(value) <= 0)) return 'invalid';
  return [
    ...budgets
      .filter((b) => b.period !== period)
      .map((b) => ({
        period: b.period,
        ...(b.limitUsd !== null ? { limitUsd: b.limitUsd } : {}),
        ...(b.limitTokens !== null ? { limitTokens: b.limitTokens } : {}),
        alertThresholds: b.alertThresholds,
      })),
    ...(value ? [{ period, limitUsd: value }] : []),
  ];
}

/** `id, hours, requests, tokens, usd` per line; empty caps are left out (trailing ones dropped). */
export const windowsText = (windows: ProviderSpend['credentials'][number]['quotaWindows']) =>
  windows
    .map((w) =>
      [
        w.id,
        String(w.hours),
        w.limitRequests !== undefined ? String(w.limitRequests) : '',
        w.limitTokens !== undefined ? String(w.limitTokens) : '',
        w.limitUsd ?? '',
      ]
        .join(', ')
        .replace(/(, )+$/, ''),
    )
    .join('\n');

const positiveInt = (v: string) => (/^\d+$/.test(v) && Number(v) > 0 ? Number(v) : undefined);

export function parseWindows(text: string): QuotaWindows | { invalid: string } {
  const out: QuotaWindows = [];
  for (const line of text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)) {
    const [id = '', hours = '', requests = '', tokens = '', usd = '', ...rest] = line
      .split(',')
      .map((p) => p.trim());
    const h = positiveInt(hours);
    const r = positiveInt(requests);
    const k = positiveInt(tokens);
    const usdOk = usd === '' || (USD.test(usd) && Number(usd) > 0);
    if (
      rest.length > 0 ||
      !/^[a-z0-9][a-z0-9-]{0,31}$/.test(id) ||
      h === undefined ||
      h > 744 ||
      (requests !== '' && r === undefined) ||
      (tokens !== '' && k === undefined) ||
      !usdOk ||
      (r === undefined && k === undefined && usd === '')
    )
      return { invalid: line };
    out.push({
      id,
      hours: h,
      ...(r !== undefined ? { limitRequests: r } : {}),
      ...(k !== undefined ? { limitTokens: k } : {}),
      ...(usd !== '' ? { limitUsd: usd } : {}),
    });
  }
  return out;
}

/** `h:mm:ss` (or `Nd h:mm:ss`) until `resetAt`. */
export function countdown(resetAt: string, now: number): string {
  const total = Math.max(0, Math.ceil((Date.parse(resetAt) - now) / 1000));
  const days = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3_600);
  const m = Math.floor((total % 3_600) / 60);
  const s = total % 60;
  const clock = `${String(h)}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return days > 0 ? `${String(days)}d ${clock}` : clock;
}

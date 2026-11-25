/**
 * Quota windows of a credential with a live countdown to their reset (card 32.6). The reset time
 * comes from the gateway's window counter, so the countdown follows the window as defined: its
 * length from the first request.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { formatNumber } from '../lib/date';
import { countdown } from '../lib/provider-spend';

export interface QuotaWindowState {
  id: string;
  hours: number;
  limitRequests: number | null;
  limitTokens: number | null;
  limitUsd: string | null;
  used: { requests: number; tokens: number; usd: string };
  resetAt: string | null;
  exhausted: boolean;
}

export function QuotaCountdown({
  quotas,
  lang,
}: {
  quotas: readonly QuotaWindowState[];
  lang: 'fa' | 'en';
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1_000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  if (quotas.length === 0) return null;
  const n = (v: number) => formatNumber(v, lang);
  return (
    <ul className="flex w-full flex-col gap-1 ps-2 text-xs text-fg-2">
      {quotas.map((q) => {
        const used = [
          q.limitRequests !== null
            ? t('quota.requests', { used: n(q.used.requests), limit: n(q.limitRequests) })
            : null,
          q.limitTokens !== null
            ? t('quota.tokens', { used: n(q.used.tokens), limit: n(q.limitTokens) })
            : null,
          q.limitUsd !== null ? t('quota.usd', { used: q.used.usd, limit: q.limitUsd }) : null,
        ].filter(Boolean);
        return (
          <li key={q.id} data-testid={`quota-${q.id}`} className={q.exhausted ? 'text-warn' : ''}>
            {t('quota.window', { id: q.id, hours: n(q.hours) })}: {used.join(' · ')} ·{' '}
            {q.resetAt ? (
              <span data-testid="quota-countdown" dir="ltr">
                {t('quota.resetsIn', { time: countdown(q.resetAt, now) })}
              </span>
            ) : (
              t('quota.notStarted')
            )}
            {q.exhausted ? ` · ${t('quota.exhausted')}` : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Current spend of every team and project on the cost page (card 25.5): today and this month (UTC,
 * the periods the gateway counts budgets in) with each budget's share used and the rate limits.
 */
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import type { LimitsControllerUsage200 } from '../api/generated';
import { api } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { useFormat } from '../lib/s2-format';
import { Section } from './s2/common';
import { FormError } from './ui/field';
import { Loading } from './ui/states';

export function ScopeUsageSection({ orgId }: { orgId: string }) {
  const { t } = useTranslation();
  const { n, usd } = useFormat();
  const usage = useQuery({
    queryKey: ['scope-usage', orgId],
    queryFn: () => api<LimitsControllerUsage200>(`/orgs/${orgId}/limits/usage`),
    refetchInterval: 30_000,
  });
  const scopes = usage.data?.scopes ?? [];

  return (
    <Section title={t('scopeLimits.usage.title')} help={t('scopeLimits.usage.help')}>
      {usage.isError ? <FormError message={errorMessage(usage.error, t)} /> : null}
      {usage.isPending ? (
        <Loading />
      ) : scopes.length === 0 ? (
        <p className="text-sm text-muted">{t('scopeLimits.empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="scope-usage">
            <thead>
              <tr className="text-xs text-muted">
                <th className="py-1.5 text-start font-medium">{t('scopeLimits.usage.name')}</th>
                <th className="py-1.5 text-end font-medium">{t('scopeLimits.usage.today')}</th>
                <th className="py-1.5 text-end font-medium">{t('scopeLimits.usage.month')}</th>
                <th className="py-1.5 ps-4 text-start font-medium">
                  {t('scopeLimits.usage.budgets')}
                </th>
                <th className="py-1.5 text-start font-medium">{t('scopeLimits.usage.rate')}</th>
              </tr>
            </thead>
            <tbody>
              {scopes.map((s) => (
                <tr
                  key={`${s.scope}:${s.scopeId}`}
                  className="border-t border-border align-top"
                  data-testid={`usage-${s.scope}-${s.scopeId}`}
                >
                  <td className="py-2 pe-3">
                    <span className="font-medium">{s.name}</span>{' '}
                    <span className="text-xs text-muted">{t(`scopeLimits.scope.${s.scope}`)}</span>
                  </td>
                  <td className="num py-2 pe-3 text-end" data-testid="usage-today">
                    {usd(s.today.usd)}
                    <span className="block text-xs text-muted">
                      {t('scopeLimits.usage.tokens', { n: n(s.today.tokens) })}
                    </span>
                  </td>
                  <td className="num py-2 pe-3 text-end" data-testid="usage-month">
                    {usd(s.month.usd)}
                    <span className="block text-xs text-muted">
                      {t('scopeLimits.usage.tokens', { n: n(s.month.tokens) })}
                    </span>
                  </td>
                  <td className="py-2 ps-4 pe-3">
                    {s.budgets.length === 0 ? (
                      <span className="text-xs text-muted">{t('scopeLimits.usage.noBudget')}</span>
                    ) : (
                      <ul className="flex min-w-48 flex-col gap-2">
                        {s.budgets.map((b) => {
                          const used = b.usedPercent ?? 0;
                          const limit =
                            b.limitUsd !== null
                              ? usd(b.limitUsd)
                              : t('scopeLimits.summary.tokens', { n: n(b.limitTokens ?? 0) });
                          const spent =
                            b.limitUsd !== null
                              ? usd(b.spentUsd)
                              : t('scopeLimits.summary.tokens', { n: n(b.spentTokens) });
                          return (
                            <li key={b.id} className="text-xs" data-testid="usage-budget">
                              <div className="flex justify-between gap-2">
                                <span>{t(`s2.cost.period.${b.period}`)}</span>
                                <span className="text-muted">
                                  {t('scopeLimits.usage.used', { spent, limit })}
                                </span>
                              </div>
                              <div
                                role="progressbar"
                                aria-label={`${s.name} ${t(`s2.cost.period.${b.period}`)}`}
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-valuenow={Math.min(100, used)}
                                className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2"
                              >
                                <div
                                  className={`h-full rounded-full ${used >= 100 ? 'bg-danger' : used >= 80 ? 'bg-warn' : 'bg-chart-1'}`}
                                  style={{ width: `${String(Math.min(100, used))}%` }}
                                />
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </td>
                  <td className="py-2 text-xs text-muted">
                    {s.rateLimit
                      ? [
                          s.rateLimit.rpm !== null
                            ? t('scopeLimits.summary.rpm', { n: n(s.rateLimit.rpm) })
                            : null,
                          s.rateLimit.tpm !== null
                            ? t('scopeLimits.summary.tpm', { n: n(s.rateLimit.tpm) })
                            : null,
                          s.rateLimit.maxConcurrency !== null
                            ? t('scopeLimits.summary.concurrency', {
                                n: n(s.rateLimit.maxConcurrency),
                              })
                            : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')
                      : t('scopeLimits.usage.noRate')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

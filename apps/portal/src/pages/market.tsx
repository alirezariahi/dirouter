/** Public model market: what can be used and what it costs, before signing up. */
import { useQuery } from '@tanstack/react-query';

import { api } from '../lib/api';
import { usd } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { Link } from '../lib/link';
import { Card, Mono, Notice } from '../lib/ui';

export interface Market {
  models: {
    slug: string;
    name: string;
    contextWindow: number | null;
    capabilities: string[];
    price: { inputPerMTok?: string; outputPerMTok?: string; perRequestUsd?: string };
  }[];
  plans: { id: string; name: string; priceUsd: string; includedUsd: string }[];
}

export function MarketPage({ signedIn }: { signedIn: boolean }) {
  const { t, lang } = useI18n();
  const market = useQuery({ queryKey: ['market'], queryFn: () => api<Market>('/portal/market') });
  const models = market.data?.models ?? [];
  return (
    <div className="space-y-8">
      <header className="space-y-3 py-6">
        <h1 className="text-3xl font-bold text-stone-900">{t.tagline}</h1>
        {!signedIn && (
          <Link
            href="/signup"
            className="inline-block rounded-md bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800"
          >
            {t.signUp}
          </Link>
        )}
      </header>

      <Card title={t.market}>
        {market.isLoading && <p className="text-sm text-stone-500">{t.loading}</p>}
        {market.isSuccess && models.length === 0 && <Notice>{t.noModels}</Notice>}
        {models.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-stone-500">
                <tr className="border-b border-stone-200 text-start">
                  <th className="py-2 text-start font-medium">{t.model}</th>
                  <th className="py-2 text-start font-medium">{t.input}</th>
                  <th className="py-2 text-start font-medium">{t.output}</th>
                  <th className="py-2 text-start font-medium">{t.context}</th>
                </tr>
              </thead>
              <tbody>
                {models.map((m) => (
                  <tr key={m.slug} className="border-b border-stone-100 last:border-0">
                    <td className="py-2.5">
                      <Mono>{m.slug}</Mono>
                    </td>
                    {m.price.perRequestUsd !== undefined ? (
                      <td colSpan={2} className="py-2.5">
                        <Mono>{usd(m.price.perRequestUsd)}</Mono> {t.perRequest}
                      </td>
                    ) : (
                      <>
                        <td className="py-2.5">
                          <Mono>{usd(m.price.inputPerMTok)}</Mono>
                        </td>
                        <td className="py-2.5">
                          <Mono>{usd(m.price.outputPerMTok)}</Mono>
                        </td>
                      </>
                    )}
                    <td className="py-2.5 text-stone-600">
                      {m.contextWindow
                        ? m.contextWindow.toLocaleString(lang === 'fa' ? 'fa-IR' : 'en-US')
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {(market.data?.plans.length ?? 0) > 0 && (
        <Card title={t.plans}>
          <ul className="grid gap-3 sm:grid-cols-3">
            {market.data?.plans.map((p) => (
              <li key={p.id} className="rounded-md border border-stone-200 p-4">
                <p className="font-medium text-stone-900">{p.name}</p>
                <p className="mt-1 text-lg font-semibold">
                  <Mono>{usd(p.priceUsd)}</Mono>{' '}
                  <span className="text-sm font-normal text-stone-500">{t.perMonth}</span>
                </p>
                <p className="text-sm text-stone-600">
                  <Mono>{usd(p.includedUsd)}</Mono> {t.included}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

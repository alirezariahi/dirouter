/** Balance at a glance and a copy-paste first request. */
import { useQuery } from '@tanstack/react-query';

import { GATEWAY_URL } from '../config';
import { api } from '../lib/api';
import { usd } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { Link } from '../lib/link';
import { Card, CopyBlock } from '../lib/ui';
import { useWallet } from '../lib/wallet';
import type { Market } from './market';

export function HomePage() {
  const { t } = useI18n();
  const wallet = useWallet();
  const market = useQuery({ queryKey: ['market'], queryFn: () => api<Market>('/portal/market') });
  const model = market.data?.models[0]?.slug ?? 'MODEL';
  const curl = `curl ${GATEWAY_URL}/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${model}", "messages": [{"role": "user", "content": "Hello"}]}'`;
  const w = wallet.data?.wallet;
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <Card title={t.balance}>
          <p className="text-3xl font-semibold text-stone-900" dir="ltr">
            {w ? usd(w.balanceUsd) : '—'}
          </p>
          <p className="mt-1 text-sm text-stone-500">
            {t.available}: <bdi dir="ltr">{w ? usd(w.availableUsd) : '—'}</bdi>
          </p>
          <Link
            href="/app/billing"
            className="mt-4 inline-block text-sm font-medium text-teal-700 hover:underline"
          >
            {t.topUp}
          </Link>
        </Card>
        <Card title={t.keys}>
          <p className="text-sm text-stone-600">{t.quickStartHint}</p>
          <Link
            href="/app/keys"
            className="mt-4 inline-block text-sm font-medium text-teal-700 hover:underline"
          >
            {t.createKey}
          </Link>
        </Card>
      </div>
      <Card title={t.quickStart}>
        <CopyBlock text={curl} />
      </Card>
    </div>
  );
}

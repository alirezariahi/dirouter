/** Balance at a glance and a copy-paste first request. */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { GATEWAY_URL } from '../config';
import { api } from '../lib/api';
import { usd } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { Link } from '../lib/router';
import { orgId } from '../lib/session';
import { Button, Card } from '../lib/ui';
import type { Market } from './market';

export interface WalletSummary {
  prepaid: boolean;
  wallet: { id: string; balanceUsd: string; heldUsd: string; availableUsd: string } | null;
}

export const useWallet = () =>
  useQuery({
    queryKey: ['wallet', orgId()],
    queryFn: () => api<WalletSummary>(`/orgs/${orgId()}/wallet`),
  });

export function CopyBlock({ text }: { text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre
        dir="ltr"
        className="overflow-x-auto rounded-md bg-stone-900 p-4 text-left text-xs leading-relaxed text-stone-100"
      >
        {text}
      </pre>
      <Button
        variant="quiet"
        className="absolute end-2 top-2 border-stone-600 bg-stone-800 py-1 text-xs text-stone-100 hover:bg-stone-700"
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
          });
        }}
      >
        {copied ? t.copied : t.copy}
      </Button>
    </div>
  );
}

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

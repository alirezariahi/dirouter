/**
 * Provider plugin choice in the provider wizard (card 21.2). A plugin with a terms warning shows
 * the warning, and the wizard cannot continue until the operator explicitly accepts it.
 */
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { api } from '../lib/api';
import type { PluginChoice, PluginInfo } from '../lib/plugins';
import { ErrorState, Loading } from './ui/states';

export function PluginPicker({
  org,
  choice,
  onChange,
}: {
  org: string;
  choice: PluginChoice;
  onChange: (choice: PluginChoice) => void;
}) {
  const { t } = useTranslation();
  const plugins = useQuery({
    queryKey: ['provider-plugins', org],
    queryFn: () => api<PluginInfo[]>(`/orgs/${org}/providers/plugins`),
  });
  if (plugins.isPending) return <Loading />;
  if (plugins.isError)
    return <ErrorState error={plugins.error} onRetry={() => void plugins.refetch()} />;
  if (plugins.data.length === 0)
    return <p className="text-sm text-muted">{t('s3.plugins.none')}</p>;

  const selected = choice.plugin;
  return (
    <div className="flex flex-col gap-3" data-testid="plugin-picker">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">{t('s3.plugins.choose')}</span>
        <select
          className="h-10 rounded-lg border border-border bg-surface px-3 text-sm"
          value={selected?.name ?? ''}
          onChange={(event) => {
            const plugin = plugins.data.find((p) => p.name === event.target.value);
            onChange({ ...(plugin ? { plugin } : {}), acceptTerms: false });
          }}
        >
          <option value="">—</option>
          {plugins.data.map((p) => (
            <option key={p.name} value={p.name} disabled={p.status !== 'available'}>
              {p.displayName ?? p.name}
              {p.status === 'available' ? '' : ` (${t('s3.plugins.failed')})`}
            </option>
          ))}
        </select>
      </label>
      {selected?.description ? <p className="text-sm text-muted">{selected.description}</p> : null}
      {selected?.status === 'failed' ? (
        <p className="text-sm text-danger">{selected.error}</p>
      ) : null}
      {selected?.termsWarning ? (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-lg border border-warn/40 bg-warn/10 p-3 text-sm"
        >
          <strong>{t('s3.plugins.termsTitle')}</strong>
          <p>{selected.termsWarning.text}</p>
          {selected.termsWarning.url ? (
            <a
              className="text-brand underline"
              href={selected.termsWarning.url}
              target="_blank"
              rel="noreferrer"
            >
              {t('s3.plugins.termsLink')}
            </a>
          ) : null}
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={choice.acceptTerms}
              onChange={(event) => {
                onChange({ ...choice, acceptTerms: event.target.checked });
              }}
            />
            {t('s3.plugins.accept')}
          </label>
        </div>
      ) : null}
    </div>
  );
}

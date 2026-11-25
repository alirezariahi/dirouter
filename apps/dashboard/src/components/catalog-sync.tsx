/**
 * Catalog and price sync (card 27.5): source settings, recent runs and the price changes waiting
 * for approval. Only the platform organization's operators see it; for any other organization the
 * API answers 404 and the panel renders nothing.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api, ApiError } from '../lib/api';
import { formatDate } from '../lib/date';
import { prefs } from '../lib/prefs';
import { errorMessage } from '../lib/errors';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { FormError } from './ui/field';

interface SyncSettings {
  enabled?: boolean;
  sources?: string[];
  mode?: 'manual' | 'auto';
  maxChangeFactor?: number;
}
interface SyncRun {
  id: string;
  status: string;
  sources: string[];
  mode: string;
  added: number;
  updated: number;
  repriced: number;
  proposed: number;
  removed: number;
  error: string | null;
  startedAt: string;
}
interface SyncStatus {
  settings: SyncSettings;
  pendingProposals: number;
  runs: SyncRun[];
}
interface Pricing {
  inputPerMTok: string;
  outputPerMTok: string;
  tiers?: unknown[];
}
export interface PriceProposal {
  id: string;
  catalogKey: string;
  currentPricing: Pricing | null;
  proposedPricing: Pricing;
  changeFactor: string | null;
  reason: string;
}

const price = (p: Pricing | null) =>
  p ? `${p.inputPerMTok} / ${p.outputPerMTok}${p.tiers?.length ? ' +tiers' : ''}` : '—';

export function CatalogSync({ base, canManage }: { base: string; canManage: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ['catalog-sync', base],
    queryFn: () => api<SyncStatus>(`${base}/catalog-sync`),
    retry: false,
  });
  const proposals = useQuery({
    queryKey: ['catalog-proposals', base],
    queryFn: () => api<PriceProposal[]>(`${base}/catalog-sync/proposals?status=pending`),
    enabled: status.isSuccess,
  });
  const [draft, setDraft] = useState<{ sources: string; mode: string; enabled: boolean }>();
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['catalog-sync', base] });
    await qc.invalidateQueries({ queryKey: ['catalog-proposals', base] });
    // Approved prices change the organization's models.
    await qc.invalidateQueries({ queryKey: ['model-management'] });
  };
  const save = useMutation({
    mutationFn: (body: SyncSettings) =>
      api(`${base}/catalog-sync/settings`, { method: 'PUT', body }),
    onSuccess: () => {
      setDraft(undefined);
      void refresh();
    },
  });
  const run = useMutation({
    mutationFn: () => api(`${base}/catalog-sync/run`, { method: 'POST' }),
    onSuccess: () => void refresh(),
  });
  const decide = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'approve' | 'reject' }) =>
      api(`${base}/catalog-sync/proposals/${id}/${action}`, { method: 'POST' }),
    onSuccess: () => void refresh(),
  });

  // Not the platform organization: the routes do not exist for it.
  if (status.error instanceof ApiError && status.error.status === 404) return null;
  if (!status.data || !Array.isArray(status.data.runs)) return null;
  const current = status.data.settings;
  const form = draft ?? {
    sources: (current.sources ?? []).join('\n'),
    mode: current.mode ?? '',
    enabled: current.enabled ?? true,
  };
  const failure = save.error ?? run.error ?? decide.error;
  const last = status.data.runs[0];
  const when = (iso: string) =>
    formatDate(iso, { calendar: prefs.calendar(), lang: prefs.lang(), time: true });

  return (
    <Card data-testid="catalog-sync">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">{t('models.sync.title')}</h2>
          <p className="mt-1 text-sm text-muted">{t('models.sync.help')}</p>
        </div>
        {canManage ? (
          <Button
            variant="outline"
            disabled={run.isPending}
            onClick={() => {
              run.mutate();
            }}
          >
            {t('models.sync.runNow')}
          </Button>
        ) : null}
      </div>
      <div className="mt-3">
        <FormError message={failure ? errorMessage(failure, t) : undefined} />
      </div>
      {last ? (
        <p className="mt-2 text-sm" data-testid="catalog-sync-last">
          {t('models.sync.lastRun', {
            date: when(last.startedAt),
            status: t(
              `models.sync.status.${last.status === 'ok' || last.status === 'failed' ? last.status : 'disabled'}`,
            ),
            added: last.added,
            proposed: last.proposed,
            repriced: last.repriced,
          })}
          {last.error ? (
            <span dir="ltr" className="block text-xs text-danger">
              {last.error}
            </span>
          ) : null}
        </p>
      ) : (
        <p className="mt-2 text-sm text-muted">{t('models.sync.neverRun')}</p>
      )}

      {canManage ? (
        <form
          className="mt-4 grid gap-3 md:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            const sources = form.sources
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean);
            save.mutate({
              enabled: form.enabled,
              sources,
              ...(form.mode === 'manual' || form.mode === 'auto' ? { mode: form.mode } : {}),
            });
          }}
        >
          <label className="flex flex-col gap-1 text-sm md:col-span-2">
            <span>{t('models.sync.sources')}</span>
            <textarea
              name="catalog-sources"
              dir="ltr"
              rows={2}
              className="rounded border border-border bg-transparent p-2 font-mono text-xs"
              placeholder={t('models.sync.sourcesPlaceholder')}
              value={form.sources}
              onChange={(event) => {
                setDraft({ ...form, sources: event.target.value });
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span>{t('models.sync.mode')}</span>
            <select
              name="catalog-mode"
              className="h-9 rounded border border-border bg-transparent px-2"
              value={form.mode}
              onChange={(event) => {
                setDraft({ ...form, mode: event.target.value });
              }}
            >
              <option value="">{t('models.sync.modeDefault')}</option>
              <option value="manual">{t('models.sync.modeManual')}</option>
              <option value="auto">{t('models.sync.modeAuto')}</option>
            </select>
          </label>
          <label className="flex items-center gap-2 self-end text-sm">
            <input
              type="checkbox"
              name="catalog-enabled"
              checked={form.enabled}
              onChange={(event) => {
                setDraft({ ...form, enabled: event.target.checked });
              }}
            />
            {t('models.sync.enabled')}
          </label>
          <div className="md:col-span-2">
            <Button type="submit" disabled={save.isPending}>
              {t('models.save')}
            </Button>
          </div>
        </form>
      ) : null}

      <h3 className="mt-5 font-medium">
        {t('models.sync.pending', { count: status.data.pendingProposals })}
      </h3>
      {(proposals.data ?? []).length === 0 ? (
        <p className="mt-1 text-sm text-muted">{t('models.sync.noPending')}</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {(proposals.data ?? []).map((p) => (
            <li
              key={p.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded border border-border px-3 py-2 text-sm"
            >
              <div>
                <code dir="ltr">{p.catalogKey}</code>
                <p dir="ltr" className="text-xs text-muted">
                  {price(p.currentPricing)} → {price(p.proposedPricing)}
                  {p.changeFactor ? ` (×${p.changeFactor})` : ''}
                </p>
                <p className="text-xs text-muted">
                  {t(
                    `models.sync.reason.${p.reason === 'large_change' ? 'large_change' : 'manual_mode'}`,
                  )}
                </p>
              </div>
              {canManage ? (
                <div className="flex gap-2">
                  <Button
                    className="h-7 px-2 text-xs"
                    disabled={decide.isPending}
                    onClick={() => {
                      decide.mutate({ id: p.id, action: 'approve' });
                    }}
                  >
                    {t('models.sync.approve')}
                  </Button>
                  <Button
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    disabled={decide.isPending}
                    onClick={() => {
                      decide.mutate({ id: p.id, action: 'reject' });
                    }}
                  >
                    {t('models.sync.reject')}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

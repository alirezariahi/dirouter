/**
 * Semantic cache administration (card 13.2): counters for the organization, a sample of cached
 * prompts for those allowed to see them, and a purge. When pgvector is not installed the API
 * answers `available: false` and the section only says so.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../../lib/api';
import { formatDate } from '../../lib/date';
import { errorMessage } from '../../lib/errors';
import { useFormat } from '../../lib/s2-format';
import { Button } from '../ui/button';
import { FormError } from '../ui/field';
import { Loading } from '../ui/states';
import { Section } from './common';

interface SemanticCacheInfo {
  /** false when the pgvector table does not exist; older servers omit the field. */
  available?: boolean;
  enabled: boolean;
  embeddingModel: string | null;
  entries: number;
  textBytes: number;
  dimensions: number;
  /** Prompt excerpts are only sent to roles that may also purge the cache. */
  sampleAllowed?: boolean;
  sample?: {
    id: string;
    model_slug: string;
    text: string;
    expires_at: string;
    created_at: string;
  }[];
}

export function SemanticCacheSection({ orgId }: { orgId: string }) {
  const { t } = useTranslation();
  const { n, settings } = useFormat();
  const qc = useQueryClient();
  const [armed, setArmed] = useState(false);
  const [purged, setPurged] = useState<number>();
  const path = `/orgs/${orgId}/cache/semantic`;
  const info = useQuery({
    queryKey: ['semantic-cache', orgId],
    queryFn: () => api<SemanticCacheInfo>(path, { query: { limit: 10 } }),
  });
  const purge = useMutation({
    mutationFn: () => api<{ deleted: number }>(path, { method: 'DELETE' }),
    onSuccess: (result) => {
      setPurged(result.deleted);
      void qc.invalidateQueries({ queryKey: ['semantic-cache', orgId] });
    },
    onSettled: () => {
      setArmed(false);
    },
  });
  const data = info.data;
  const failure = purge.error ?? info.error;
  const date = (iso: string) =>
    formatDate(iso, { calendar: settings.calendar, lang: settings.lang, time: true });

  return (
    <Section title={t('s2.semantic.title')} help={t('s2.semantic.help')}>
      <FormError message={failure ? errorMessage(failure, t) : undefined} />
      {info.isPending ? (
        <Loading />
      ) : !data ? null : data.available === false ? (
        <p data-testid="semantic-unavailable" role="status" className="text-sm text-muted">
          {t('s2.semantic.unavailable')}
        </p>
      ) : (
        <>
          <p data-testid="semantic-stats" className="text-sm">
            {data.enabled ? t('s2.common.enabled') : t('s2.common.disabled')}
            {data.embeddingModel ? (
              <>
                {' · '}
                <span dir="ltr">{data.embeddingModel}</span>
              </>
            ) : null}
            {' · '}
            {t('s2.semantic.entries', { n: n(data.entries) })}
            {' · '}
            {t('s2.semantic.size', {
              n: n(data.textBytes / 1024, { maximumFractionDigits: 1 }),
            })}
          </p>
          {data.sampleAllowed === false ? (
            <p data-testid="semantic-sample-hidden" className="text-xs text-muted">
              {t('s2.semantic.sampleHidden')}
            </p>
          ) : (
            <>
              {data.sample?.length ? (
                <ul data-testid="semantic-sample" className="flex flex-col">
                  {data.sample.map((row) => (
                    <li key={row.id} className="border-t border-border py-1.5 text-sm">
                      <p className="text-xs text-muted">
                        <span dir="ltr">{row.model_slug}</span> · {date(row.created_at)} ·{' '}
                        {t('s2.semantic.expires', { date: date(row.expires_at) })}
                      </p>
                      <p dir="auto" className="break-words">
                        {row.text}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted">{t('s2.common.none')}</p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {armed ? (
                  <>
                    <span className="text-sm">{t('s2.semantic.purgeConfirm')}</span>
                    <Button
                      disabled={purge.isPending}
                      onClick={() => {
                        purge.mutate();
                      }}
                    >
                      {t('s2.semantic.purge')}
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="outline"
                    disabled={data.entries === 0}
                    onClick={() => {
                      setPurged(undefined);
                      setArmed(true);
                    }}
                  >
                    {t('s2.semantic.purge')}
                  </Button>
                )}
                {purged !== undefined ? (
                  <span role="status" className="text-xs text-muted">
                    {t('s2.semantic.purged', { n: n(purged) })}
                  </span>
                ) : null}
              </div>
            </>
          )}
        </>
      )}
    </Section>
  );
}

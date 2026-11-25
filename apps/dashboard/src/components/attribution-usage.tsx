/**
 * Usage by attribution dimension on the Analytics page: end users (card 33.2), tags and cost
 * centers (card 33.4). Grouped by value, or one value's usage by model; exported as CSV.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { StatsControllerDimensions200 } from '../api/generated';
import { api } from '../lib/api';
import { downloadCsv } from '../lib/csv';
import { useFormat } from '../lib/s2-format';
import { BarList } from './charts/bar-list';
import { Section, selectClass } from './s2/common';
import { Button } from './ui/button';

export type Dimension = 'end_user' | 'tag' | 'cost_center';
const OTHER = '__other__';

export function AttributionUsage({
  orgId,
  from,
  to,
  dimensions,
}: {
  orgId: string;
  from: string;
  to: string;
  dimensions: readonly Dimension[];
}) {
  const { t } = useTranslation();
  const { n, usd } = useFormat();
  const [dimension, setDimension] = useState<Dimension>(dimensions[0] ?? 'end_user');
  const [value, setValue] = useState('');
  const filter = value.trim();
  const query = useQuery({
    queryKey: ['attribution', orgId, dimension, filter, from, to],
    queryFn: () =>
      api<StatsControllerDimensions200>(`/orgs/${orgId}/stats/dimensions`, {
        query: {
          dimension,
          from,
          to,
          limit: 1000,
          ...(filter ? { value: filter, groupBy: 'model' } : {}),
        },
      }),
    enabled: Boolean(orgId),
    placeholderData: keepPreviousData,
  });
  const items = query.data?.items ?? [];
  const label = (id: string) => (id === OTHER ? t('attribution.other') : id);

  return (
    <Section
      title={`${t('attribution.title')} ${t(`attribution.dimensions.${dimension}`)}`}
      help={t('attribution.help')}
      action={
        <Button
          variant="outline"
          disabled={items.length === 0}
          onClick={() => {
            downloadCsv(
              `dirouter-${dimension}${filter ? `-${filter}` : ''}-${from.slice(0, 10)}_${to.slice(0, 10)}.csv`,
              [
                filter ? 'model' : dimension,
                'requests',
                'errors',
                'input_tokens',
                'output_tokens',
                'cost_usd',
                'charge_usd',
              ],
              items.map((item) => [
                item.id,
                item.requests,
                item.errors,
                item.inputTokens,
                item.outputTokens,
                item.costUsd,
                item.chargeUsd,
              ]),
            );
          }}
        >
          <Download aria-hidden className="size-4" strokeWidth={1.5} />
          {t('attribution.export')}
        </Button>
      }
    >
      <div className="flex flex-wrap items-end gap-3">
        {dimensions.length > 1 ? (
          <label className="flex flex-col gap-1 text-sm">
            <span>{t('attribution.dimension')}</span>
            <select
              className={selectClass}
              value={dimension}
              onChange={(event) => {
                setDimension(event.target.value as Dimension);
                setValue('');
              }}
            >
              {dimensions.map((d) => (
                <option key={d} value={d}>
                  {t(`attribution.dimensions.${d}`)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="flex flex-col gap-1 text-sm" title={t('attribution.filterHelp')}>
          <span>{t('attribution.filter')}</span>
          <input
            className={selectClass}
            dir="ltr"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
            }}
          />
        </label>
        {filter ? (
          <Button
            variant="ghost"
            onClick={() => {
              setValue('');
            }}
          >
            {t('attribution.clear')}
          </Button>
        ) : null}
      </div>
      {filter ? (
        <p className="text-sm text-muted">{t('attribution.byModel', { value: filter })}</p>
      ) : null}
      <BarList
        testId={`attribution-${dimension}`}
        items={items.slice(0, 20).map((item) => ({
          id: item.id,
          label: label(item.id),
          value: Number(item.costUsd),
          display: usd(item.costUsd),
          meta: t('attribution.requests', { n: n(item.requests) }),
        }))}
        empty={t('attribution.none')}
        onSelect={
          filter
            ? undefined
            : (id) => {
                if (id !== OTHER) setValue(id);
              }
        }
      />
    </Section>
  );
}

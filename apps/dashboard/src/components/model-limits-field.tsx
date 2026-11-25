/**
 * Limits of a key on single models (card 33.3): one row per model, alias or combo, with RPM, TPM,
 * input and output TPM and a budget. Part of the key form; read back with `modelLimitsFrom`.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  emptyRow,
  type ModelLimitRow,
  type ModelLimitView,
  RATE_FIELDS,
  rowsOf,
} from '../lib/model-limits';
import { PERIODS } from '../lib/scope-limits';
import { Button } from './ui/button';

const input = 'h-9 w-full rounded-lg border border-border bg-surface px-2 text-sm';

export function ModelLimitsField({ initial }: { initial?: readonly ModelLimitView[] }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<ModelLimitRow[]>(() => rowsOf(initial));
  const set = (i: number, patch: Partial<ModelLimitRow>) => {
    setRows((old) => old.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };
  return (
    <fieldset data-testid="model-limits">
      <legend className="mb-1 text-sm font-medium">{t('keys.modelLimits.title')}</legend>
      <p className="mb-2 text-xs text-muted">{t('keys.modelLimits.help')}</p>
      <input type="hidden" name="modelLimitCount" value={rows.length} />
      <div className="flex flex-col gap-2">
        {rows.map((row, i) => {
          const name = (field: string) => `modelLimit.${String(i)}.${field}`;
          return (
            <div
              key={i}
              className="grid gap-2 rounded-lg border border-border p-2 sm:grid-cols-4"
              data-testid={`model-limit-${String(i)}`}
            >
              <input type="hidden" name={name('keep')} value={JSON.stringify(row.keep)} />
              <label className="flex flex-col gap-1 text-xs sm:col-span-2">
                <span>{t('keys.modelLimits.model')}</span>
                <input
                  className={input}
                  dir="ltr"
                  name={name('model')}
                  value={row.model}
                  placeholder="openai/gpt-5"
                  onChange={(e) => {
                    set(i, { model: e.target.value });
                  }}
                />
              </label>
              {RATE_FIELDS.map((field) => (
                <label key={field} className="flex flex-col gap-1 text-xs">
                  <span>{t(`keys.${field}`)}</span>
                  <input
                    className={input}
                    dir="ltr"
                    type="number"
                    min={1}
                    step={1}
                    name={name(field)}
                    value={row[field]}
                    onChange={(e) => {
                      set(i, { [field]: e.target.value });
                    }}
                  />
                </label>
              ))}
              <label className="flex flex-col gap-1 text-xs">
                <span>{t('keys.modelLimits.period')}</span>
                <select
                  className={input}
                  name={name('period')}
                  value={row.period}
                  onChange={(e) => {
                    set(i, { period: e.target.value as ModelLimitRow['period'] });
                  }}
                >
                  {PERIODS.map((p) => (
                    <option key={p} value={p}>
                      {t(`keys.period.${p}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span>{t('keys.budgetUsd')}</span>
                <input
                  className={input}
                  dir="ltr"
                  type="number"
                  min="0.00000001"
                  step="any"
                  name={name('usd')}
                  value={row.usd}
                  onChange={(e) => {
                    set(i, { usd: e.target.value });
                  }}
                />
              </label>
              <div className="flex items-end">
                <Button
                  variant="ghost"
                  className="h-9 text-danger"
                  onClick={() => {
                    setRows((old) => old.filter((_, j) => j !== i));
                  }}
                >
                  {t('keys.modelLimits.remove')}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
      <Button
        variant="outline"
        className="mt-2 h-8 px-2 text-xs"
        onClick={() => {
          setRows((old) => [...old, emptyRow()]);
        }}
      >
        {t('keys.modelLimits.add')}
      </Button>
    </fieldset>
  );
}

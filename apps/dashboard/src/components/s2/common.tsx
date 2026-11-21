/** Small building blocks shared by the Sprint 2 pages. */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { RANGES, setRange, useRange } from '../../lib/range';
import { Card } from '../ui/card';

/** The global dashboard time range (shared with the Overview and Request Log pages). */
export function RangeTabs() {
  const { t } = useTranslation();
  const range = useRange();
  return (
    <div
      role="radiogroup"
      aria-label={t('overview.range')}
      className="flex gap-1 rounded-lg border border-border p-1"
    >
      {RANGES.map((r) => (
        <button
          key={r}
          type="button"
          role="radio"
          aria-checked={range === r}
          onClick={() => {
            setRange(r);
          }}
          className={`rounded-md px-3 py-1 text-sm ${range === r ? 'bg-brand text-white' : 'hover:bg-surface-2'}`}
        >
          {t(`overview.ranges.${r}`)}
        </button>
      ))}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
      </div>
      {children}
    </header>
  );
}

export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="flex flex-col gap-1">
      <span className="text-xs text-muted">{label}</span>
      <span className="text-xl font-semibold" dir="ltr">
        {value}
      </span>
      {hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </Card>
  );
}

export function Section({
  title,
  help,
  children,
  action,
}: {
  title: string;
  help?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          {help ? <p className="mt-1 text-xs text-muted">{help}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </Card>
  );
}

export const selectClass = 'h-10 rounded-md border border-border bg-surface px-3 text-sm';
export const textareaClass =
  'min-h-24 rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand';

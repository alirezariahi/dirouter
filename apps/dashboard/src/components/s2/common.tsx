/** Small building blocks shared by the pages: header, range switch, stat tile, section. */
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../lib/cn';
import { RANGES, setRange, useRange } from '../../lib/range';
import { Card } from '../ui/card';

/** Segmented control: one choice of a few, the selection is a raised surface step. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  size = 'md',
  mode = 'radio',
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  ariaLabel?: string;
  size?: 'sm' | 'md';
  /** `toggle` renders pressed buttons instead of radios, for switches inside a chart header. */
  mode?: 'radio' | 'toggle';
}) {
  const radio = mode === 'radio';
  return (
    <div
      role={radio ? 'radiogroup' : 'group'}
      aria-label={ariaLabel}
      className="inline-flex gap-0.5 rounded-lg bg-surface-2 p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          {...(radio
            ? { role: 'radio', 'aria-checked': value === option.value }
            : { 'aria-pressed': value === option.value })}
          onClick={() => {
            onChange(option.value);
          }}
          className={cn(
            'rounded-lg font-medium whitespace-nowrap transition-colors duration-150',
            size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-[13px]',
            value === option.value
              ? 'bg-surface text-fg shadow-[0_1px_2px_rgba(0,0,0,0.08)] dark:bg-fg/10 dark:shadow-none'
              : 'text-fg-2 hover:text-fg',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** The global dashboard time range (shared with the Overview and Request Log pages). */
export function RangeTabs() {
  const { t } = useTranslation();
  const range = useRange();
  return (
    <Segmented
      ariaLabel={t('overview.range')}
      value={range}
      onChange={setRange}
      options={RANGES.map((r) => ({ value: r, label: t(`overview.ranges.${r}`) }))}
    />
  );
}

export function PageHeader({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl leading-8 font-semibold">{title}</h1>
        {subtitle ? <div className="mt-1 max-w-2xl text-sm text-fg-2">{subtitle}</div> : null}
      </div>
      {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
    </header>
  );
}

/** Change against the previous period; `good` decides the color, not the direction. */
export function Delta({ text, up, good }: { text: string; up: boolean; good: boolean }) {
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cn('inline-flex items-center gap-1 text-xs', good ? 'text-good' : 'text-danger')}
    >
      <Icon aria-hidden className="size-3.5 rtl:-scale-x-100" strokeWidth={1.75} />
      <bdi>{text}</bdi>
    </span>
  );
}

/** A number with its label, and optionally what it compares to. */
export function Stat({
  label,
  value,
  hint,
  delta,
  testId,
  size = 'md',
}: {
  label: string;
  value: string;
  hint?: string;
  delta?: ReactNode;
  testId?: string;
  size?: 'md' | 'lg';
}) {
  return (
    <Card className="flex flex-col gap-2">
      <span className="text-[13px] text-fg-2">{label}</span>
      <span
        data-testid={testId}
        className={cn('num leading-none font-medium', size === 'lg' ? 'text-[32px]' : 'text-2xl')}
      >
        <bdi>{value}</bdi>
      </span>
      {delta ?? (hint ? <span className="text-xs text-muted">{hint}</span> : null)}
    </Card>
  );
}

export function Section({
  title,
  help,
  children,
  action,
  className,
}: {
  title: string;
  help?: string;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn('flex flex-col gap-4', className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[15px] leading-6 font-medium">{title}</h2>
          {help ? <p className="mt-0.5 text-[13px] text-muted">{help}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </Card>
  );
}

export const selectClass =
  'h-10 rounded-lg border border-border bg-surface px-3 text-sm outline-none';
export const textareaClass =
  'min-h-24 rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none';

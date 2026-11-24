/** Pieces shared by the billing pages (cards 25.1, 25.2): tables, status badges, exact money. */
import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';
import { trimUsd } from '../../lib/billing';
import { useFormat } from '../../lib/s2-format';
import { Card } from '../ui/card';

export interface Column {
  key: string;
  label: ReactNode;
  /** Numbers line up at the end of the cell. */
  numeric?: boolean;
  className?: string;
}

/** A hairline table inside a card; scrolls sideways on narrow screens instead of squeezing. */
export function DataTable({
  columns,
  children,
  testId,
  minWidth = 720,
  caption,
}: {
  columns: readonly Column[];
  children: ReactNode;
  testId?: string;
  minWidth?: number;
  caption?: string;
}) {
  return (
    <Card className="overflow-x-auto p-0">
      <table
        data-testid={testId}
        className="w-full text-sm"
        style={{ minWidth: `${String(minWidth)}px` }}
      >
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead className="text-xs text-muted">
          <tr className="border-b border-border">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cn(
                  'px-4 py-2.5 font-medium whitespace-nowrap',
                  column.numeric ? 'text-end' : 'text-start',
                  column.className,
                )}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </Card>
  );
}

export const rowClass =
  'border-b border-border/60 align-top transition-colors duration-150 last:border-b-0 hover:bg-surface-2/50';
export const cellClass = 'px-4 py-2.5';
export const numClass = 'num px-4 py-2.5 text-end whitespace-nowrap';

type Tone = 'good' | 'warn' | 'danger' | 'muted' | 'brand';
const TONES: Record<Tone, string> = {
  good: 'bg-good',
  warn: 'bg-warn',
  danger: 'bg-danger',
  muted: 'bg-muted/50',
  brand: 'bg-brand',
};
const TEXT: Record<Tone, string> = {
  good: 'text-good',
  warn: 'text-warn',
  danger: 'text-danger',
  muted: 'text-muted',
  brand: 'text-fg',
};

/** A lamp and a word, like the key states on the Virtual keys page. */
export function Status({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <span aria-hidden className={cn('lamp', TONES[tone])} />
      <span className={TEXT[tone]}>{label}</span>
    </span>
  );
}

/**
 * A ledger amount: formatted for reading, with the exact figure (8 decimals, as the API sends
 * it) in the tooltip and in `data-exact` so nothing is lost to rounding.
 */
export function Money({ value, signed = false }: { value: string; signed?: boolean }) {
  const { usd } = useFormat();
  const exact = trimUsd(value);
  const positive = signed && !exact.startsWith('-') && exact !== '0';
  return (
    <bdi title={`USD ${exact}`} data-exact={exact} className="num">
      {positive ? '+' : ''}
      {usd(value)}
    </bdi>
  );
}

/** Quiet line under a form: what happened, or why the controls are off. */
export function Notice({ children, tone = 'muted' }: { children: ReactNode; tone?: Tone }) {
  return (
    <p role="status" className={cn('text-[13px]', TEXT[tone])}>
      {children}
    </p>
  );
}

export const inputClass =
  'h-10 rounded-lg border border-border bg-surface px-3 text-sm outline-none placeholder:text-muted';

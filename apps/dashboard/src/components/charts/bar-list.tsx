/**
 * Ranked list with thin bars: a breakdown next to the main chart (top models, keys, providers).
 * One neutral bar color; the leader is not highlighted, the order already says it.
 */
import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';

export interface BarListItem {
  id: string;
  label: ReactNode;
  value: number;
  /** Formatted value, shown at the end of the row. */
  display: string;
  /** Quiet extra figure before the value (e.g. request count next to cost). */
  meta?: string;
}

export function BarList({
  items,
  onSelect,
  empty,
  testId,
  tone = 'brand',
}: {
  items: BarListItem[];
  onSelect?: (id: string) => void;
  empty: string;
  testId?: string;
  tone?: 'brand' | 'neutral';
}) {
  const max = Math.max(0, ...items.map((i) => i.value));
  if (items.length === 0) return <p className="py-6 text-center text-sm text-muted">{empty}</p>;
  return (
    <ul data-testid={testId} className="flex flex-col gap-1">
      {items.map((item) => {
        const row = (
          <>
            <span className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate font-mono text-[13px] text-fg" dir="ltr">
                {item.label}
              </span>
              <span className="num flex shrink-0 items-baseline gap-2 text-[13px]">
                {item.meta ? <span className="text-muted">{item.meta}</span> : null}
                <span className="font-medium text-fg">{item.display}</span>
              </span>
            </span>
            <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-surface-2">
              <span
                className={cn(
                  'block h-full rounded-full',
                  tone === 'brand' ? 'bg-chart-1' : 'bg-fg-2/50',
                )}
                style={{ width: `${String(max > 0 ? Math.max(2, (item.value / max) * 100) : 0)}%` }}
              />
            </span>
          </>
        );
        return (
          <li key={item.id}>
            {onSelect ? (
              <button
                type="button"
                onClick={() => {
                  onSelect(item.id);
                }}
                className="block w-full rounded-lg px-2 py-2 text-start transition-colors duration-150 hover:bg-surface-2"
              >
                {row}
              </button>
            ) : (
              <div className="px-2 py-2">{row}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { Empty, ErrorState, Loading } from './states';

/** Each column has a stable key and a render function; windowing applies to rows, not DOM pagination. */
export function VirtualTable<T>({
  rows,
  columns,
  rowKey,
  onRow,
  loading = false,
  error,
  onRetry,
  onEnd,
  hasMore = false,
}: {
  rows: T[];
  columns: { key: string; label: string; render: (row: T) => React.ReactNode }[];
  rowKey: (row: T) => string;
  onRow?: (row: T) => void;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  onEnd?: () => void;
  hasMore?: boolean;
}) {
  const { t } = useTranslation();
  const parent = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 48,
    measureElement: (element) => element.getBoundingClientRect().height || 48,
    initialRect: { width: 0, height: 480 },
    observeElementRect: (instance, callback) => {
      const element = instance.scrollElement;
      if (!element) return;
      const measure = () => {
        const { offsetWidth: width, offsetHeight: height } = element;
        // A hidden or not-yet-laid-out viewport must not erase the initial window.
        if (height > 0) callback({ width, height });
      };
      measure();
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      return () => {
        observer.disconnect();
      };
    },
    overscan: 12,
  });

  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (loading && rows.length === 0) return <Loading />;
  if (rows.length === 0) return <Empty title={t('logs.empty')} />;

  return (
    <div ref={parent} className="max-h-[65vh] overflow-auto" data-testid="virtual-log-table">
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10 bg-surface text-muted">
          <tr className="border-b border-border">
            {columns.map((c) => (
              <th key={c.key} className="px-3 py-2 text-start font-medium">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            if (!row) return null;
            return (
              <tr
                key={rowKey(row)}
                data-index={item.index}
                ref={virtualizer.measureElement}
                data-testid="log-row"
                tabIndex={onRow ? 0 : undefined}
                role={onRow ? 'button' : undefined}
                className="absolute top-0 w-full border-b border-border/60 hover:bg-surface-2"
                style={{ transform: `translateY(${String(item.start)}px)` }}
                onClick={() => onRow?.(row)}
                onKeyDown={(e) => {
                  if (onRow && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault();
                    onRow(row);
                  }
                }}
              >
                {columns.map((c) => (
                  <td key={c.key} className="whitespace-nowrap px-3 py-2">
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {hasMore ? (
        <button
          type="button"
          className="sticky bottom-0 w-full bg-surface py-2 text-brand"
          onClick={onEnd}
        >
          {t('logs.more')}
        </button>
      ) : null}
    </div>
  );
}

import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { Empty, ErrorState, Loading } from './states';

/**
 * Each column has a stable key and a render function; windowing applies to rows, not DOM pagination.
 * Rows are positioned absolutely, so the header and every row share one grid template to keep the
 * columns aligned.
 */
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
  columns: {
    key: string;
    label: string;
    render: (row: T) => React.ReactNode;
    /** Grid track, e.g. `minmax(0, 2fr)`; one equal share by default. */
    width?: string;
    /** Numbers read best aligned to the end of the column. */
    align?: 'start' | 'end';
  }[];
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

  const template = {
    gridTemplateColumns: columns.map((c) => c.width ?? 'minmax(0, 1fr)').join(' '),
  };

  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (loading && rows.length === 0) return <Loading />;
  if (rows.length === 0) return <Empty title={t('logs.empty')} />;

  return (
    <div ref={parent} className="max-h-[65vh] overflow-auto" data-testid="virtual-log-table">
      <table className="block w-full min-w-[720px] text-sm">
        <thead className="sticky top-0 z-10 block bg-surface text-xs text-muted">
          <tr className="grid border-b border-border" style={template}>
            {columns.map((c) => (
              <th
                key={c.key}
                className={`px-4 py-2.5 font-medium ${c.align === 'end' ? 'text-end' : 'text-start'}`}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="relative block" style={{ height: virtualizer.getTotalSize() }}>
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
                className="absolute top-0 grid w-full cursor-pointer items-center border-b border-border/60 transition-colors duration-150 hover:bg-surface-2"
                style={{ ...template, transform: `translateY(${String(item.start)}px)` }}
                onClick={() => onRow?.(row)}
                onKeyDown={(e) => {
                  if (onRow && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault();
                    onRow(row);
                  }
                }}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={`truncate px-4 py-3 ${c.align === 'end' ? 'num text-end' : ''}`}
                  >
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

/**
 * Lightweight SVG bar chart (no library, to keep the bundle and load time small).
 * Each column is clickable (drill-down) and can be selected with the keyboard. The time-axis direction in RTL
 * is reversed so "now" is on the left, like text.
 */
export interface Bar {
  label: string;
  value: number;
  /** Highlighted segment (e.g. errors) of the same column */
  highlight?: number;
}

export function BarChart({
  bars,
  height = 160,
  format,
  onSelect,
  ariaLabel,
}: {
  bars: Bar[];
  height?: number;
  format: (v: number) => string;
  onSelect?: (index: number) => void;
  ariaLabel: string;
}) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  const width = Math.max(1, bars.length) * 10;
  return (
    <svg
      role="img"
      aria-label={ariaLabel}
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      preserveAspectRatio="none"
      className="h-40 w-full rtl:-scale-x-100"
    >
      {bars.map((b, i) => {
        const h = (b.value / max) * (height - 4);
        const hh = b.highlight ? (b.highlight / max) * (height - 4) : 0;
        return (
          <g
            key={b.label}
            data-testid="bar"
            role={onSelect ? 'button' : undefined}
            tabIndex={onSelect ? 0 : undefined}
            aria-label={`${b.label}: ${format(b.value)}`}
            className={onSelect ? 'cursor-pointer outline-none focus:opacity-70' : undefined}
            onClick={
              onSelect
                ? () => {
                    onSelect(i);
                  }
                : undefined
            }
            onKeyDown={
              onSelect
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') onSelect(i);
                  }
                : undefined
            }
          >
            <title>{`${b.label}: ${format(b.value)}`}</title>
            <rect x={i * 10} y={0} width={10} height={height} fill="transparent" />
            <rect
              x={i * 10 + 1}
              y={height - h}
              width={8}
              height={h}
              className="fill-brand/70 hover:fill-brand"
            />
            {hh > 0 && (
              <rect x={i * 10 + 1} y={height - hh} width={8} height={hh} className="fill-danger" />
            )}
          </g>
        );
      })}
    </svg>
  );
}

/**
 * Parts of a whole as one stacked bar with a legend (input vs output tokens, success vs errors).
 * Segments are separated by a 2px gap in the surface color; identity is in the legend, not in
 * color alone.
 */
export interface Share {
  label: string;
  value: number;
  display: string;
  /** A Tailwind background class from the chart or status tokens. */
  color: string;
}

export function ShareBar({
  parts,
  percent,
  ariaLabel,
}: {
  parts: Share[];
  percent: (ratio: number) => string;
  ariaLabel: string;
}) {
  const total = parts.reduce((sum, p) => sum + p.value, 0);
  return (
    <div role="img" aria-label={ariaLabel} className="flex flex-col gap-3">
      <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-surface-2">
        {total > 0
          ? parts
              .filter((p) => p.value > 0)
              .map((p) => (
                <span
                  key={p.label}
                  className={`h-full first:rounded-s-full last:rounded-e-full ${p.color}`}
                  style={{ width: `${String((p.value / total) * 100)}%` }}
                />
              ))
          : null}
      </div>
      <ul className="flex flex-col gap-1.5 text-[13px]">
        {parts.map((p) => (
          <li key={p.label} className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-fg-2">
              <span className={`size-2 rounded-full ${p.color}`} />
              {p.label}
            </span>
            <span className="num flex items-baseline gap-2">
              <span className="text-muted">{total > 0 ? percent(p.value / total) : '—'}</span>
              <span className="font-medium text-fg">{p.display}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Time-series chart, drawn without a library to keep the bundle small.
 *
 * - `area`: one 2px line with a light wash under it, for a trend.
 * - `bars`: thin columns with rounded tops, for a count per period.
 * An optional secondary value (errors, say) is drawn in the status color with a legend.
 *
 * Every bucket is a full-height button: hover shows a crosshair and tooltip, click or Enter drills
 * down. The layout uses logical properties, so in RTL time runs right to left, like the text.
 */
import { useState } from 'react';

import { cn } from '../../lib/cn';

export interface TrendPoint {
  label: string;
  /** Short form for the axis; the full label stays in the tooltip. */
  tick?: string;
  value: number;
  /** Second measure of the same unit, a part of `value` (e.g. failed requests). */
  secondary?: number;
}

/** Round axis maximum and three evenly spaced ticks above zero. */
function niceScale(max: number): number[] {
  if (!(max > 0)) return [0, 1];
  const rough = max / 3;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= rough) ?? rough;
  const ticks: number[] = [];
  for (let v = 0; v < max + step; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

export function TrendChart({
  points,
  kind = 'area',
  height = 280,
  format,
  axisFormat,
  onSelect,
  ariaLabel,
  seriesLabel,
  secondaryLabel,
  className,
}: {
  points: TrendPoint[];
  kind?: 'area' | 'bars';
  height?: number;
  format: (v: number) => string;
  /** Shorter format for axis ticks; defaults to `format`. */
  axisFormat?: (v: number) => string;
  onSelect?: (index: number) => void;
  ariaLabel: string;
  seriesLabel?: string;
  secondaryLabel?: string;
  className?: string;
}) {
  const [hover, setHover] = useState<number>();
  const ticks = niceScale(Math.max(0, ...points.map((p) => p.value)));
  const top = ticks.at(-1) ?? 1;
  const pct = (v: number) => (Math.max(0, v) / top) * 100;
  const count = Math.max(1, points.length);
  const hasSecondary = secondaryLabel !== undefined && points.some((p) => (p.secondary ?? 0) > 0);
  const tick = axisFormat ?? format;

  // Line through the middle of each bucket, in a 0..100 box stretched to the plot.
  const x = (i: number) => ((i + 0.5) / count) * 100;
  const line = (pick: (p: TrendPoint) => number) =>
    points
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(3)},${(100 - pct(pick(p))).toFixed(3)}`)
      .join(' ');
  const main = line((p) => p.value);
  const area =
    points.length > 0
      ? `${main} L${x(points.length - 1).toFixed(3)},100 L${x(0).toFixed(3)},100 Z`
      : '';

  // About six date labels, always including the first and the last bucket.
  const every = Math.max(1, Math.ceil(points.length / 6));
  const shown = hover === undefined ? undefined : points[hover];

  return (
    <figure role="img" aria-label={ariaLabel} className={cn('flex flex-col gap-3', className)}>
      {hasSecondary ? (
        <figcaption className="flex items-center gap-4 text-xs text-fg-2">
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-chart-1" />
            {seriesLabel}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-danger" />
            {secondaryLabel}
          </span>
        </figcaption>
      ) : null}
      <div className="flex gap-3">
        <div
          aria-hidden
          className="num flex shrink-0 flex-col-reverse justify-between text-end text-xs leading-none text-muted"
          style={{ height }}
        >
          {ticks.map((v) => (
            <span key={v} className="-translate-y-1/2 first:translate-y-0 last:translate-y-0">
              {tick(v)}
            </span>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <div className="relative" style={{ height }}>
            {ticks.map((v) => (
              <span
                key={v}
                aria-hidden
                className={cn(
                  'absolute inset-x-0 border-t',
                  v === 0 ? 'border-border' : 'border-chart-grid',
                )}
                style={{ bottom: `${String(pct(v))}%` }}
              />
            ))}
            {kind === 'area' && points.length > 1 ? (
              <svg
                aria-hidden
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                className="absolute inset-0 size-full overflow-visible rtl:-scale-x-100"
              >
                <path d={area} className="fill-chart-1/10" />
                <path
                  d={main}
                  fill="none"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                  className="stroke-chart-1"
                />
                {hasSecondary ? (
                  <path
                    d={line((p) => p.secondary ?? 0)}
                    fill="none"
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                    className="stroke-danger"
                  />
                ) : null}
              </svg>
            ) : null}
            <div
              className="absolute inset-0 flex"
              onMouseLeave={() => {
                setHover(undefined);
              }}
            >
              {points.map((p, i) => {
                const active = hover === i;
                const single = kind === 'bars' || points.length === 1;
                return (
                  <button
                    key={p.label}
                    type="button"
                    data-testid="bar"
                    aria-label={`${p.label}: ${format(p.value)}`}
                    tabIndex={onSelect ? 0 : -1}
                    onMouseEnter={() => {
                      setHover(i);
                    }}
                    onFocus={() => {
                      setHover(i);
                    }}
                    onBlur={() => {
                      setHover(undefined);
                    }}
                    onClick={
                      onSelect
                        ? () => {
                            onSelect(i);
                          }
                        : undefined
                    }
                    className={cn(
                      'group relative flex min-w-0 flex-1 items-end justify-center px-px outline-none',
                      onSelect ? 'cursor-pointer' : 'cursor-default',
                    )}
                  >
                    {/* Crosshair for the hovered bucket */}
                    <span
                      aria-hidden
                      className={cn(
                        'absolute inset-y-0 w-px bg-fg/15 transition-opacity duration-150',
                        active && !single ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                    {single ? (
                      <span
                        aria-hidden
                        className={cn(
                          'relative flex w-full max-w-6 flex-col-reverse overflow-hidden rounded-t-[4px] bg-chart-1 transition-opacity duration-150',
                          hover !== undefined && !active && 'opacity-45',
                        )}
                        style={{
                          height: `${String(pct(p.value))}%`,
                          minHeight: p.value > 0 ? 2 : 0,
                        }}
                      >
                        {hasSecondary && (p.secondary ?? 0) > 0 ? (
                          <span
                            className="w-full border-t-2 border-surface bg-danger"
                            style={{
                              height: `${String((Math.min(p.secondary ?? 0, p.value) / p.value) * 100)}%`,
                              minHeight: 3,
                            }}
                          />
                        ) : null}
                      </span>
                    ) : (
                      <span
                        aria-hidden
                        className={cn(
                          'absolute size-2.5 translate-y-1/2 rounded-full bg-chart-1 ring-2 ring-surface transition-opacity duration-150',
                          active ? 'opacity-100' : 'opacity-0 group-focus-visible:opacity-100',
                        )}
                        style={{ bottom: `${String(pct(p.value))}%` }}
                      />
                    )}
                  </button>
                );
              })}
            </div>
            {shown && hover !== undefined ? (
              <div
                role="tooltip"
                className={cn(
                  'pointer-events-none absolute top-0 z-10 min-w-36 rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-[0_8px_24px_rgba(0,0,0,0.12)]',
                  hover / count > 0.6 ? '-translate-x-full rtl:translate-x-full' : '',
                )}
                style={{
                  insetInlineStart: `calc(${String(((hover + 0.5) / count) * 100)}% + ${hover / count > 0.6 ? '-12px' : '12px'})`,
                }}
              >
                <p className="mb-1.5 text-muted">{shown.label}</p>
                <p className="flex items-center justify-between gap-4">
                  <span className="flex items-center gap-1.5 text-fg-2">
                    <span className="size-2 rounded-full bg-chart-1" />
                    {seriesLabel ?? ariaLabel}
                  </span>
                  <span className="num font-medium text-fg">{format(shown.value)}</span>
                </p>
                {hasSecondary ? (
                  <p className="mt-1 flex items-center justify-between gap-4">
                    <span className="flex items-center gap-1.5 text-fg-2">
                      <span className="size-2 rounded-full bg-danger" />
                      {secondaryLabel}
                    </span>
                    <span className="num font-medium text-fg">{format(shown.secondary ?? 0)}</span>
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
          <div aria-hidden className="num mt-2 flex text-xs text-muted">
            {points.map((p, i) => (
              <span key={p.label} className="flex min-w-0 flex-1 justify-center">
                {i % every === 0 ? (
                  <span className="whitespace-nowrap">{p.tick ?? p.label}</span>
                ) : null}
              </span>
            ))}
          </div>
        </div>
      </div>
    </figure>
  );
}

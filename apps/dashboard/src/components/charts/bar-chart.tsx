/** Column chart: the bars form of TrendChart, kept under its original name and props. */
import { TrendChart } from './trend-chart';

export interface Bar {
  label: string;
  tick?: string;
  value: number;
  /** Highlighted segment (e.g. errors) of the same column */
  highlight?: number;
}

export function BarChart({
  bars,
  height = 220,
  format,
  onSelect,
  ariaLabel,
  highlightLabel,
}: {
  bars: Bar[];
  height?: number;
  format: (v: number) => string;
  onSelect?: (index: number) => void;
  ariaLabel: string;
  highlightLabel?: string;
}) {
  return (
    <TrendChart
      kind="bars"
      height={height}
      ariaLabel={ariaLabel}
      seriesLabel={ariaLabel}
      format={format}
      points={bars.map((b) => ({
        label: b.label,
        ...(b.tick ? { tick: b.tick } : {}),
        value: b.value,
        ...(b.highlight !== undefined ? { secondary: b.highlight } : {}),
      }))}
      {...(highlightLabel ? { secondaryLabel: highlightLabel } : {})}
      {...(onSelect ? { onSelect } : {})}
    />
  );
}

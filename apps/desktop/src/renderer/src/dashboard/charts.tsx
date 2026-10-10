import { useState, type ReactNode } from "react";

/*
 * Hand-made SVG/HTML charts (decision 6: no chart library), following the dataviz specs:
 * thin marks (bars <= 24px, 4px rounded data end, square at the baseline), a 2px surface gap
 * between touching bars, hairline solid grid, one axis, text in ink tokens (never the series
 * color), a legend for two or more series, hover AND keyboard-focus tooltips, and a table view
 * for every chart so no value depends on hovering.
 */

const COMPACT = new Intl.NumberFormat("en-PH", { notation: "compact", maximumFractionDigits: 1 });

/** Axis labels only ("₱120K"); exact amounts use formatPesos. Display, never stored. */
export function compactPesos(centavos: number): string {
  return `${centavos < 0 ? "-" : ""}₱${COMPACT.format(Math.abs(centavos) / 100)}`;
}

/** Clean tick steps (1, 2, 2.5, 5 × 10ⁿ) from 0 up to at least `max`. */
export function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const rough = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? rough;
  const ticks: number[] = [];
  for (let t = 0; t < max + step; t += step) ticks.push(Math.round(t));
  return ticks;
}

/** A path for a column with a 4px rounded top and a square base at `baseY`. */
function columnPath(x: number, y: number, width: number, baseY: number): string {
  const r = Math.min(4, width / 2, baseY - y);
  if (r <= 0) return `M${x},${baseY}H${x + width}`;
  return `M${x},${baseY}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${baseY}Z`;
}

/* ---------------------------------- Card ---------------------------------- */

interface ChartCardProps {
  title: string;
  subtitle?: string;
  legend?: ReactNode;
  /** The chart; omit for cards that are only a table. */
  chart?: ReactNode;
  table: ReactNode;
  className?: string;
}

/** A dashboard card with a Chart / Table switch (the table is the accessible twin). */
export function ChartCard({ title, subtitle, legend, chart, table, className = "" }: ChartCardProps) {
  const [showTable, setShowTable] = useState(false);
  return (
    <section className={`rounded-lg border border-slate-200 bg-surface p-4 ${className}`}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-navy">{title}</h2>
          {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
        </div>
        {chart && (
          <button
            className="shrink-0 rounded border border-slate-300 px-2 py-0.5 text-xs text-ink hover:bg-slate-100"
            aria-pressed={showTable}
            onClick={() => setShowTable((v) => !v)}
          >
            {showTable ? "Chart" : "Table"}
          </button>
        )}
      </div>
      {chart && !showTable && legend && <div className="mb-2">{legend}</div>}
      {chart && !showTable ? chart : table}
    </section>
  );
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-4 text-xs text-muted">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: i.color }} />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------ Grouped columns ------------------------------ */

export interface ColumnSeries {
  label: string;
  color: string;
}

interface ColumnPairChartProps {
  groups: { key: string; label: string; values: number[]; note?: string }[];
  series: ColumnSeries[];
  /** Exact value text for tooltips (formatPesos). */
  format: (value: number) => string;
}

const W = 640;
const H = 240;
const PAD = { top: 12, right: 8, bottom: 28, left: 56 };
const BAR_MAX = 24;
const GAP = 2;

/**
 * Columns per group (e.g. billed vs collected per month) on one peso axis. Hovering or
 * focusing a group shows one tooltip with every series' exact value.
 */
export function ColumnPairChart({ groups, series, format }: ColumnPairChartProps) {
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(0, ...groups.flatMap((g) => g.values));
  const ticks = niceTicks(max);
  const top = ticks.at(-1) || 1;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const baseY = PAD.top + plotH;
  const band = plotW / Math.max(1, groups.length);
  const barW = Math.min(BAR_MAX, (band * 0.6 - GAP * (series.length - 1)) / series.length);
  const groupW = barW * series.length + GAP * (series.length - 1);
  const y = (v: number) => baseY - (Math.max(0, v) / top) * plotH;

  const activeGroup = active === null ? null : groups[active];
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Column chart; use the Table button for the values">
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(t)}
              y2={y(t)}
              stroke={t === 0 ? "var(--color-axis)" : "var(--color-grid)"}
              strokeWidth={1}
            />
            <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted text-[11px] tabular-nums">
              {compactPesos(t)}
            </text>
          </g>
        ))}
        {groups.map((g, gi) => {
          const x0 = PAD.left + band * gi + (band - groupW) / 2;
          return (
            <g key={g.key}>
              {active === gi && <rect x={PAD.left + band * gi} y={PAD.top} width={band} height={plotH} className="fill-slate-100" />}
              {g.values.map((v, si) => (
                <path key={si} d={columnPath(x0 + si * (barW + GAP), y(v), barW, baseY)} fill={series[si]!.color} />
              ))}
              <text x={PAD.left + band * gi + band / 2} y={H - 10} textAnchor="middle" className="fill-muted text-[11px]">
                {g.label}
              </text>
              {/* The whole band is the hit target, larger than the bars. */}
              <rect
                x={PAD.left + band * gi}
                y={PAD.top}
                width={band}
                height={plotH + PAD.bottom}
                fill="transparent"
                tabIndex={0}
                role="button"
                aria-label={`${g.label}: ${series.map((s, si) => `${s.label} ${format(g.values[si] ?? 0)}`).join(", ")}`}
                className="cursor-default outline-none focus-visible:stroke-accent"
                onPointerEnter={() => setActive(gi)}
                onPointerLeave={() => setActive(null)}
                onFocus={() => setActive(gi)}
                onBlur={() => setActive(null)}
              />
            </g>
          );
        })}
      </svg>
      {activeGroup && active !== null && (
        <div
          role="tooltip"
          className="pointer-events-none absolute top-2 z-10 min-w-44 -translate-x-1/2 rounded-md border border-slate-200 bg-surface px-3 py-2 text-xs shadow-md"
          style={{ left: `${((PAD.left + band * active + band / 2) / W) * 100}%` }}
        >
          <div className="mb-1 font-medium text-ink">{activeGroup.label}</div>
          {series.map((s, si) => (
            <div key={s.label} className="flex items-center gap-2">
              <span aria-hidden="true" className="inline-block h-0.5 w-3" style={{ background: s.color }} />
              <span className="font-semibold tabular-nums text-ink">{format(activeGroup.values[si] ?? 0)}</span>
              <span className="text-muted">{s.label}</span>
            </div>
          ))}
          {activeGroup.note && <div className="mt-1 text-muted">{activeGroup.note}</div>}
        </div>
      )}
    </div>
  );
}

/* ------------------------------ Horizontal bars ------------------------------ */

interface HBarListProps {
  rows: { key: string; label: string; value: number; note?: string }[];
  format: (value: number) => string;
  color?: string;
}

/** One series as horizontal bars with the value at each bar's tip (negative values show no bar). */
export function HBarList({ rows, format, color = "var(--color-series-1)" }: HBarListProps) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-2">
      {rows.map((r) => {
        const pct = max > 0 ? (Math.max(0, r.value) / max) * 100 : 0;
        return (
          <li key={r.key} className="grid grid-cols-[7rem_1fr] items-center gap-3 text-xs">
            <span className="truncate text-ink">{r.label}</span>
            <span className="flex min-w-0 items-center gap-2">
              {/* The longest bar takes 65% of the row, leaving room for its value at the tip. */}
              <span
                className="h-3.5 shrink-0 rounded-r-[4px] transition-opacity hover:opacity-80"
                style={{ width: `${pct * 0.65}%`, background: color, minWidth: r.value > 0 ? 2 : 0 }}
              />
              <span className="whitespace-nowrap tabular-nums text-ink">
                {format(r.value)}
                {r.note && <span className="ml-1 text-muted">{r.note}</span>}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/* ---------------------------------- Meter ---------------------------------- */

/** A rate as a small meter: accent fill on a lighter track of the same blue, the % beside it. */
export function RateMeter({ basisPoints, text }: { basisPoints: number | null; text: string }) {
  const pct = basisPoints === null ? 0 : Math.min(100, Math.max(0, basisPoints / 100));
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span aria-hidden="true" className="h-1.5 w-16 overflow-hidden rounded-full" style={{ background: "var(--color-series-track)" }}>
        <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: "var(--color-series-1)" }} />
      </span>
      <span className="w-12 text-right tabular-nums">{text}</span>
    </span>
  );
}

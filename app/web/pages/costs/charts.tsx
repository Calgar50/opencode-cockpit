// Graphiques SVG du tableau de bord des coûts (sans dépendance).
// Règles : une seule échelle par graphique, marques fines, grille en filet, info-bulle au survol et au clavier.
import { useLayoutEffect, useRef, useState } from "react";
import { formatDay, formatInt, formatUsd } from "../../lib/format.ts";

export function useWidth<T extends HTMLElement>(initial = 640) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(initial);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth || initial);
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(w);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [initial]);
  return [ref, width] as const;
}

export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = 10 ** Math.floor(Math.log10(value));
  const fraction = value / exponent;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * exponent;
}

function tickLabel(value: number): string {
  if (value === 0) return "0";
  if (value < 1) return `${value.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} $`;
  return `${formatInt(value)} $`;
}

/** Colonne à extrémité arrondie (4 px), carrée sur la ligne de base. */
function columnPath(x: number, y: number, width: number, baseline: number): string {
  const h = baseline - y;
  if (h <= 0) return "";
  const r = Math.min(4, width / 2, h);
  return `M${x},${baseline}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${baseline}Z`;
}

const PAD = { top: 12, right: 12, bottom: 26, left: 52 };

export function DailySpendChart({
  days,
  daysInMonth,
  dailyBudget,
  height = 220,
}: {
  days: Array<{ day: string; cost: number; calls: number }>;
  daysInMonth: number;
  dailyBudget: number;
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const plotW = Math.max(width - PAD.left - PAD.right, 10);
  const plotH = height - PAD.top - PAD.bottom;
  const max = niceMax(Math.max(...days.map((d) => d.cost), dailyBudget) * 1.1);
  const band = plotW / Math.max(daysInMonth, 1);
  const barW = Math.max(Math.min(24, band - 2), 1);
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const ticks = [0, max / 4, max / 2, (3 * max) / 4, max];
  const labelEvery = daysInMonth > 20 && width < 700 ? 7 : 5;
  const hovered = hover !== null ? days[hover] : undefined;

  return (
    <div className="chart" ref={ref} style={{ height }}>
      <svg height={height} role="img" aria-label="Dépense par jour">
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid-line" x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
            <text className="tick" x={PAD.left - 8} y={y(t) + 4} textAnchor="end">
              {tickLabel(t)}
            </text>
          </g>
        ))}
        <line className="axis-line" x1={PAD.left} x2={width - PAD.right} y1={y(0)} y2={y(0)} />
        {days.map((d, i) => {
          const x = PAD.left + i * band + (band - barW) / 2;
          return (
            <path
              key={d.day}
              d={columnPath(x, y(d.cost), barW, y(0))}
              fill="var(--series-1)"
              opacity={hover === null || hover === i ? 1 : 0.55}
            />
          );
        })}
        {dailyBudget > 0 ? (
          <g>
            <line x1={PAD.left} x2={width - PAD.right} y1={y(dailyBudget)} y2={y(dailyBudget)} stroke="var(--text-3)" strokeWidth={1} strokeDasharray="4 4" />
            <text className="tick" x={width - PAD.right} y={y(dailyBudget) - 5} textAnchor="end">
              rythme du budget : {formatUsd(dailyBudget)} / jour
            </text>
          </g>
        ) : null}
        {Array.from({ length: daysInMonth }, (_, i) => i + 1)
          .filter((n) => n === 1 || n % labelEvery === 0)
          .map((n) => (
            <text key={n} className="tick" x={PAD.left + (n - 1) * band + band / 2} y={height - 8} textAnchor="middle">
              {n}
            </text>
          ))}
        {days.map((d, i) => (
          <rect
            key={`hit-${d.day}`}
            x={PAD.left + i * band}
            y={PAD.top}
            width={band}
            height={plotH}
            fill="transparent"
            tabIndex={0}
            aria-label={`${formatDay(d.day)} : ${formatUsd(d.cost)}, ${d.calls} appels`}
            onPointerEnter={() => setHover(i)}
            onPointerLeave={() => setHover(null)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
          />
        ))}
      </svg>
      {hovered && hover !== null ? (
        <div className="chart-tooltip" style={{ left: PAD.left + hover * band + band / 2, top: y(hovered.cost) }}>
          <strong>{formatUsd(hovered.cost)}</strong>
          <span className="muted">
            {formatDay(hovered.day)} · {formatInt(hovered.calls)} appel{hovered.calls > 1 ? "s" : ""}
          </span>
        </div>
      ) : null}
    </div>
  );
}

export function CumulativeChart({
  days,
  daysInMonth,
  budget,
  projected,
  showProjection,
  height = 220,
}: {
  days: Array<{ day: string; cost: number }>;
  daysInMonth: number;
  budget: number;
  projected: number;
  showProjection: boolean;
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const cumulative: number[] = [];
  let running = 0;
  for (const d of days) {
    running += d.cost;
    cumulative.push(running);
  }
  const plotW = Math.max(width - PAD.left - PAD.right, 10);
  const plotH = height - PAD.top - PAD.bottom;
  const max = niceMax(Math.max(budget, showProjection ? projected : 0, running) * 1.08);
  const x = (index: number) => PAD.left + (daysInMonth <= 1 ? plotW / 2 : (index / (daysInMonth - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const ticks = [0, max / 4, max / 2, (3 * max) / 4, max];
  const points = cumulative.map((v, i) => `${x(i)},${y(v)}`);
  const last = cumulative.length - 1;
  const linePath = points.length > 0 ? `M${points.join("L")}` : "";
  const areaPath = points.length > 0 ? `${linePath}L${x(last)},${y(0)}L${x(0)},${y(0)}Z` : "";
  const hoveredValue = hover !== null ? cumulative[hover] : undefined;
  const hoveredDay = hover !== null ? days[hover] : undefined;

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / Math.max(rect.width, 1);
    const index = Math.round(ratio * (daysInMonth - 1));
    setHover(Math.max(0, Math.min(last, index)));
  };

  return (
    <div className="chart" ref={ref} style={{ height }}>
      <svg height={height} role="img" aria-label="Dépense cumulée du mois comparée au budget">
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid-line" x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
            <text className="tick" x={PAD.left - 8} y={y(t) + 4} textAnchor="end">
              {tickLabel(t)}
            </text>
          </g>
        ))}
        <line className="axis-line" x1={PAD.left} x2={width - PAD.right} y1={y(0)} y2={y(0)} />
        {budget > 0 ? (
          <g>
            <line x1={PAD.left} x2={width - PAD.right} y1={y(budget)} y2={y(budget)} stroke="var(--critical)" strokeWidth={1.5} />
            <text className="tick" x={PAD.left + 6} y={y(budget) - 6}>
              Budget {formatUsd(budget)}
            </text>
          </g>
        ) : null}
        {areaPath ? <path d={areaPath} fill="var(--series-1)" opacity={0.1} /> : null}
        {showProjection && last >= 0 && last < daysInMonth - 1 ? (
          <line
            x1={x(last)}
            y1={y(cumulative[last] ?? 0)}
            x2={x(daysInMonth - 1)}
            y2={y(projected)}
            stroke="var(--series-1)"
            strokeWidth={2}
            strokeDasharray="5 5"
            opacity={0.55}
          />
        ) : null}
        {linePath ? <path d={linePath} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" /> : null}
        {last >= 0 ? (
          <g>
            <circle cx={x(last)} cy={y(cumulative[last] ?? 0)} r={6} fill="var(--surface-1)" />
            <circle cx={x(last)} cy={y(cumulative[last] ?? 0)} r={4} fill="var(--series-1)" />
          </g>
        ) : null}
        {showProjection && last < daysInMonth - 1 ? (
          <text className="tick" x={x(daysInMonth - 1)} y={y(projected) - 8} textAnchor="end">
            projection {formatUsd(projected)}
          </text>
        ) : null}
        {hover !== null && hoveredValue !== undefined ? (
          <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={y(0)} stroke="var(--axis)" strokeWidth={1} />
        ) : null}
        {[1, 8, 15, 22, daysInMonth].map((n) => (
          <text key={n} className="tick" x={x(n - 1)} y={height - 8} textAnchor="middle">
            {n}
          </text>
        ))}
        <rect
          x={PAD.left}
          y={PAD.top}
          width={plotW}
          height={plotH}
          fill="transparent"
          tabIndex={0}
          aria-label="Survolez pour lire le cumul jour par jour"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          onFocus={() => setHover(last)}
          onBlur={() => setHover(null)}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? last) - 1));
            if (e.key === "ArrowRight") setHover((h) => Math.min(last, (h ?? last) + 1));
          }}
        />
      </svg>
      {hover !== null && hoveredValue !== undefined && hoveredDay ? (
        <div className="chart-tooltip" style={{ left: x(hover), top: y(hoveredValue) }}>
          <strong>{formatUsd(hoveredValue)}</strong>
          <span className="muted">
            cumul au {formatDay(hoveredDay.day)}
            {budget > 0 ? ` · ${Math.round((hoveredValue / budget) * 100)} % du budget` : ""}
          </span>
        </div>
      ) : null}
    </div>
  );
}

export interface BarItem {
  key: string;
  label: string;
  value: number;
  detail?: string;
}

/** Barres horizontales classées (une seule série : couleur unique, valeur au bout). */
export function BarList({ items, empty = "Aucune donnée ce mois-ci." }: { items: BarItem[]; empty?: string }) {
  if (items.length === 0) return <p className="small muted">{empty}</p>;
  const max = Math.max(...items.map((i) => i.value), 0);
  return (
    <div role="list">
      {items.map((item) => (
        <div key={item.key} className="hbar" role="listitem">
          <span className="ellipsis small" title={item.label}>
            {item.label}
            {item.detail ? <span className="muted"> · {item.detail}</span> : null}
          </span>
          <strong className="small tabular">{formatUsd(item.value)}</strong>
          <div className="hbar-track">
            <div className="hbar-fill" style={{ width: `${max > 0 ? Math.max((item.value / max) * 100, item.value > 0 ? 1 : 0) : 0}%`, background: "var(--series-1)" }} />
          </div>
        </div>
      ))}
    </div>
  );
}

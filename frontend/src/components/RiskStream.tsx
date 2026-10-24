import { useId, useMemo, useState } from "react";
import { motion } from "framer-motion";
import type { Customer, Summary } from "../types";
import { integer, money } from "../format";
import { fadeRise, springEmphasized } from "../motion";
import { DotNumber } from "./DotNumber";

type Level = "high" | "medium" | "low";

/* Fixed series colours tuned for this card's deep-violet gradient
   (rendered identically in both themes, like the reference bento). */
const LEVELS: { key: Level; label: string; color: string }[] = [
  { key: "high", label: "Высокий", color: "#ff8f7d" },
  { key: "medium", label: "Средний", color: "#f5c451" },
  { key: "low", label: "Низкий", color: "#7fe3c0" },
];

/* Finer buckets near "now" — the nearest expiries are what retention
   acts on first, and the flow stays readable instead of one spike. */
const BUCKETS: { id: string; label: string; test: (d: number) => boolean }[] = [
  { id: "overdue", label: "просрочено", test: (d) => d < 0 },
  { id: "d3", label: "0–3 дня", test: (d) => d >= 0 && d <= 3 },
  { id: "w1", label: "4–7 дней", test: (d) => d > 3 && d <= 7 },
  { id: "w2", label: "8–14 дней", test: (d) => d > 7 && d <= 14 },
  { id: "m1", label: "15–30 дней", test: (d) => d > 14 && d <= 30 },
  { id: "later", label: "позже 30", test: (d) => d > 30 },
];

const W = 660;
const H = 250;
const MID = H / 2;
const PAD_X = 36;
const MAX_HALF = 96;

type Pt = readonly [number, number];

function smoothPath(p: Pt[], move = true): string {
  if (!p.length) return "";
  let d = `${move ? "M" : "L"} ${p[0][0].toFixed(1)} ${p[0][1].toFixed(1)}`;
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[i - 1] ?? p[i];
    const p1 = p[i];
    const p2 = p[i + 1];
    const p3 = p[i + 2] ?? p2;
    const k = 0.18;
    d += ` C ${(p1[0] + (p2[0] - p0[0]) * k).toFixed(1)} ${(p1[1] + (p2[1] - p0[1]) * k).toFixed(1)}, ${(p2[0] - (p3[0] - p1[0]) * k).toFixed(1)} ${(p2[1] - (p3[1] - p1[1]) * k).toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

/**
 * Symmetric streamgraph (the Net-Worth stream pattern from the shared
 * finance bento) fed with real data: revenue at risk per risk level
 * across service-expiry horizons, computed from the top-N customers the
 * dashboard already loads. The big total is the portfolio summary
 * figure, rendered as a counting dot-matrix number.
 */
export function RiskStream({
  summary,
  customers,
}: {
  summary: Summary;
  customers: Customer[];
}) {
  const uid = useId().replace(/:/g, "");
  const [hover, setHover] = useState<number | null>(null);

  const { matrix, totals, noDate, hasData, maxIdx } = useMemo(() => {
    const m: Record<Level, number>[] = BUCKETS.map(() => ({ high: 0, medium: 0, low: 0 }));
    let nd = 0;
    for (const c of customers) {
      if (c.score == null) continue;
      const level = c.riskLevel as Level;
      if (!(level in m[0])) continue;
      if (c.daysToExpiry == null) {
        nd += 1;
        continue;
      }
      const b = BUCKETS.findIndex((bucket) => bucket.test(c.daysToExpiry as number));
      if (b >= 0) m[b][level] += Number(c.estimatedLoss) || 0;
    }
    const t = m.map((row) => row.high + row.medium + row.low);
    const maxT = Math.max(0, ...t);
    return {
      matrix: m,
      totals: t,
      noDate: nd,
      hasData: maxT > 0,
      maxIdx: Math.max(0, t.indexOf(maxT)),
    };
  }, [customers]);

  const active = hover ?? maxIdx;
  const x = (i: number) => PAD_X + (i / (BUCKETS.length - 1)) * (W - PAD_X * 2);
  const maxTotal = Math.max(1, ...totals);
  const k = MAX_HALF / maxTotal;

  /* Cumulative half-thickness from the centre out: high, +medium, +low. */
  const cum: number[][] = LEVELS.map((_, li) =>
    matrix.map((row) =>
      LEVELS.slice(0, li + 1).reduce((sum, l) => sum + row[l.key] * k, 0),
    ),
  );
  const band = (c: number[]) =>
    smoothPath(c.map((v, i) => [x(i), MID - v] as const)) +
    smoothPath(c.map((v, i) => [x(i), MID + v] as const).reverse(), false) +
    " Z";
  const flat = band(matrix.map(() => 0));

  return (
    <motion.article
      className="panel riskstream-panel"
      variants={fadeRise}
      custom={0.16}
      initial="hidden"
      animate="show"
      aria-label="Поток выручки под риском по срокам окончания услуг"
    >
      <div className="panel-heading">
        <div>
          <span className="eyebrow">По срокам окончания</span>
          <h2>Когда деньги под угрозой</h2>
        </div>
        <div className="riskstream-legend" aria-hidden="true">
          {LEVELS.map((l) => (
            <span key={l.key}>
              <i style={{ background: l.color }} />
              {l.label}
            </span>
          ))}
        </div>
      </div>

      <div className="riskstream-total">
        <DotNumber value={summary.estimatedLoss} />
        <div>
          <span className="riskstream-caption">выручка под риском · 90 дней</span>
          <span className="riskstream-sub">
            поток по срокам — по {integer(customers.length)} загруженным клиентам
            {noDate ? ` · без даты окончания: ${integer(noDate)}` : ""}
          </span>
        </div>
      </div>

      {hasData ? (
        <>
          <svg
            className="riskstream-svg"
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={`Поток выручки под риском: пик на участке «${BUCKETS[maxIdx].label}» — ${money(totals[maxIdx])}.`}
            onPointerLeave={() => setHover(null)}
          >
            <defs>
              <linearGradient id={`${uid}-fade`} x1="0" x2="1">
                <stop offset="0" stopColor="#fff" stopOpacity="0" />
                <stop offset="0.14" stopColor="#fff" stopOpacity="1" />
                <stop offset="1" stopColor="#fff" stopOpacity="1" />
              </linearGradient>
              <mask id={`${uid}-mask`}>
                <rect width={W} height={H} fill={`url(#${uid}-fade)`} />
              </mask>
            </defs>
            <g mask={`url(#${uid}-mask)`}>
              {[2, 1, 0].map((li) => (
                <motion.path
                  key={LEVELS[li].key}
                  fill={LEVELS[li].color}
                  opacity={li === 2 ? 0.88 : 0.96}
                  initial={{ d: flat }}
                  animate={{ d: band(cum[li]) }}
                  transition={{ ...springEmphasized, delay: 0.1 + (2 - li) * 0.08 }}
                />
              ))}
            </g>
            {hover !== null && (
              <line
                x1={x(active)}
                x2={x(active)}
                y1={14}
                y2={H - 14}
                stroke="#ffffff"
                strokeOpacity="0.65"
                strokeWidth="1.5"
              />
            )}
            {BUCKETS.map((bucket, i) => {
              const left = i === 0 ? 0 : (x(i - 1) + x(i)) / 2;
              const right = i === BUCKETS.length - 1 ? W : (x(i) + x(i + 1)) / 2;
              return (
                <rect
                  key={bucket.id}
                  x={left}
                  y={0}
                  width={right - left}
                  height={H}
                  fill="transparent"
                  onPointerEnter={() => setHover(i)}
                />
              );
            })}
          </svg>

          <div className="riskstream-readout" aria-live="polite">
            <strong>{BUCKETS[active].label}</strong>
            {LEVELS.map((l) => (
              <span key={l.key} className="riskstream-readout-item">
                <i style={{ background: l.color }} aria-hidden="true" />
                {l.label.toLowerCase()}: {money(matrix[active][l.key])}
              </span>
            ))}
            <span>
              итого: <strong>{money(totals[active])}</strong>
            </span>
          </div>

          <div className="riskstream-axis" aria-hidden="true">
            {BUCKETS.map((bucket, i) => (
              <span
                key={bucket.id}
                style={{
                  left: `${(x(i) / W) * 100}%`,
                  transform:
                    i === 0
                      ? "translateX(0)"
                      : i === BUCKETS.length - 1
                        ? "translateX(-100%)"
                        : "translateX(-50%)",
                }}
              >
                {bucket.label}
              </span>
            ))}
          </div>
        </>
      ) : (
        <p className="riskstream-empty">
          У загруженных клиентов пока нет выручки под риском с датами окончания услуг —
          поток появится после загрузки снимка с услугами.
        </p>
      )}
    </motion.article>
  );
}

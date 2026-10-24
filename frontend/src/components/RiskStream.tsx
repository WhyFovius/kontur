import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import type { Customer, Summary } from "../types";
import { integer, money } from "../format";
import { fadeRise, springEmphasized } from "../motion";
import { DotNumber } from "./DotNumber";

type Level = "high" | "medium" | "low";

/* Fixed semantic series colours tuned for the Aéza black/navy card
   (rendered identically in both themes). */
const LEVELS: { key: Level; label: string; color: string }[] = [
  { key: "high", label: "Высокий", color: "#ff5c86" },
  { key: "medium", label: "Средний", color: "#ff9e57" },
  { key: "low", label: "Низкий", color: "#2fd3a6" },
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
    const k = 0.16;
    // Clamp control points to the segment's own y-range so a band can
    // never bulge past its neighbours (the un-clamped spline drew
    // "shoulders" higher than the data and pinched thin bands shut).
    const lo = Math.min(p1[1], p2[1]);
    const hi = Math.max(p1[1], p2[1]);
    const clampY = (v: number) => Math.min(hi, Math.max(lo, v));
    d += ` C ${(p1[0] + (p2[0] - p0[0]) * k).toFixed(1)} ${clampY(p1[1] + (p2[1] - p0[1]) * k).toFixed(1)}, ${(p2[0] - (p3[0] - p1[0]) * k).toFixed(1)} ${clampY(p2[1] - (p3[1] - p1[1]) * k).toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
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
  // Virtual zero points just inside both edges: the stream flows in
  // from a tip and out to a tip, symmetric and intentional at both
  // ends, instead of starting mid-air wherever bucket 0 happens to be.
  const xs = [10, ...BUCKETS.map((_, i) => x(i)), W - 10];
  const band = (c: number[]) => {
    const v = [0, ...c, 0];
    return (
      smoothPath(v.map((vv, i) => [xs[i], MID - vv] as const)) +
      smoothPath(v.map((vv, i) => [xs[i], MID + vv] as const).reverse(), false) +
      " Z"
    );
  };
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
        <DotNumber value={summary.estimatedLoss} pitch={6} />
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
            <g>
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
              <g pointerEvents="none">
                <line
                  x1={x(active)}
                  x2={x(active)}
                  y1={MID - totals[active] * k - 10}
                  y2={MID + totals[active] * k + 10}
                  stroke="#ffffff"
                  strokeOpacity="0.75"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
                <circle cx={x(active)} cy={MID - totals[active] * k} r="3.5" fill="#ffffff" />
                <circle cx={x(active)} cy={MID + totals[active] * k} r="3.5" fill="#ffffff" />
              </g>
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
                className={i === active ? "is-active" : undefined}
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

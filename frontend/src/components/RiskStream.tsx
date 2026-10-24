import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useMotionValue, useReducedMotion, useSpring } from "framer-motion";
import type { Customer, Summary } from "../types";
import { integer, money } from "../format";
import { fadeRise, springEmphasized, springFollow } from "../motion";
import { AnimatedNumber } from "./AnimatedNumber";

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

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

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
 * Symmetric streamgraph fed with real data: revenue at risk per risk
 * level across service-expiry horizons, computed from the top-N customers
 * the dashboard already loads. The big total is the portfolio summary
 * figure, rendered as a large readable counting number.
 *
 * Smoothness contract: band geometry is painted only while a data
 * change morphs (a spring on the `d` attribute); the perpetual "alive"
 * drift is a compositor transform on the whole <g> (CSS keyframes), so
 * an idle page does zero path repaints and every animation runs at the
 * display's native refresh rate. Hover is continuous: the guide chases the
 * pointer on a spring motion value and the readout interpolates between
 * bucket centres, exactly like the drawn curve between those centres.
 */
export function RiskStream({
  summary,
  customers,
}: {
  summary: Summary;
  customers: Customer[];
}) {
  const [hoverT, setHoverT] = useState<number | null>(null);
  const reduceMotion = useReducedMotion();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const pendingHover = useRef<number | null>(null);
  const hoverFrame = useRef<number | null>(null);

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
  const band = (c: number[], reveal = 1) => {
    const v = [0, ...c, 0];
    const geometry = v.map((vv) => ({
      centre: MID,
      half: Math.max(0, vv * reveal),
    }));
    return (
      smoothPath(geometry.map((g, i) => [xs[i], g.centre - g.half] as const)) +
      smoothPath(geometry.map((g, i) => [xs[i], g.centre + g.half] as const).reverse(), false) +
      " Z"
    );
  };
  const flat = band(matrix.map(() => 0));
  useEffect(
    () => () => {
      if (hoverFrame.current !== null) cancelAnimationFrame(hoverFrame.current);
    },
    [],
  );

  const guideTarget = useMotionValue(x(maxIdx));
  const guideX = useSpring(guideTarget, {
    stiffness: springFollow.stiffness,
    damping: springFollow.damping,
    mass: springFollow.mass,
  });

  useEffect(() => {
    if (hoverT === null) guideTarget.set(x(maxIdx));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guideTarget, hoverT, maxIdx]);

  const updateHover = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width) return;
    const svgX = ((event.clientX - rect.left) / rect.width) * W;
    const t = clamp(
      ((svgX - PAD_X) / (W - PAD_X * 2)) * (BUCKETS.length - 1),
      0,
      BUCKETS.length - 1,
    );
    pendingHover.current = t;
    if (hoverT === null) guideX.jump(x(t));
    guideTarget.set(x(t));
    if (hoverFrame.current !== null) return;
    hoverFrame.current = requestAnimationFrame(() => {
      hoverFrame.current = null;
      if (pendingHover.current !== null) setHoverT(pendingHover.current);
    });
  };

  const clearHover = () => {
    pendingHover.current = null;
    setHoverT(null);
  };

  const activeFloat = hoverT ?? maxIdx;
  const active = clamp(Math.round(activeFloat), 0, BUCKETS.length - 1);
  const lower = Math.floor(activeFloat);
  const upper = Math.min(BUCKETS.length - 1, lower + 1);
  const fraction = upper === lower ? 0 : activeFloat - lower;
  const interpolate = (values: number[]) =>
    values[lower] + (values[upper] - values[lower]) * fraction;
  const activeTotal = interpolate(totals);
  const activeValues = Object.fromEntries(
    LEVELS.map((l) => [l.key, interpolate(matrix.map((row) => row[l.key]))]),
  ) as Record<Level, number>;

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
        <AnimatedNumber
          value={summary.estimatedLoss}
          format={money}
          className="riskstream-total-value"
        />
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
            ref={svgRef}
            className="riskstream-svg"
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={`Поток выручки под риском: пик на участке «${BUCKETS[maxIdx].label}» — ${money(totals[maxIdx])}.`}
            onPointerEnter={updateHover}
            onPointerMove={updateHover}
            onPointerLeave={clearHover}
          >
            <g className="riskstream-flow">
              {[2, 1, 0].map((li) => (
                <motion.path
                  key={LEVELS[li].key}
                  className="riskstream-band"
                  initial={reduceMotion ? false : { d: flat }}
                  animate={{ d: band(cum[li]) }}
                  transition={{ ...springEmphasized, delay: 0.08 * (2 - li) }}
                  fill={LEVELS[li].color}
                  opacity={li === 2 ? 0.88 : 0.96}
                />
              ))}
            </g>
            {hoverT !== null && (
              <motion.g pointerEvents="none" style={{ x: guideX }}>
                <line
                  x1={0}
                  x2={0}
                  y1={MID - activeTotal * k - 10}
                  y2={MID + activeTotal * k + 10}
                  stroke="#ffffff"
                  strokeOpacity="0.75"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
                <circle cx={0} cy={MID - activeTotal * k} r="3.5" fill="#ffffff" />
                <circle cx={0} cy={MID + activeTotal * k} r="3.5" fill="#ffffff" />
              </motion.g>
            )}
          </svg>

          <div className="riskstream-readout" aria-live="polite">
            <strong>{BUCKETS[active].label}</strong>
            {LEVELS.map((l) => (
              <span key={l.key} className="riskstream-readout-item">
                <i style={{ background: l.color }} aria-hidden="true" />
                {l.label.toLowerCase()}: {money(Math.round(activeValues[l.key]))}
              </span>
            ))}
            <span>
              итого: <strong>{money(Math.round(activeTotal))}</strong>
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

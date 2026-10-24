import { AnimatePresence, motion } from "framer-motion";
import type { RiskLevel, Summary } from "../types";
import { RISK_LABELS } from "../types";
import { integer } from "../format";
import { springEmphasized, springSnappy } from "../motion";

interface RiskDonutProps {
  summary: Summary;
  activeRisk: RiskLevel | "";
  onSelectRisk: (risk: RiskLevel | "") => void;
}

const SEGMENTS: { key: RiskLevel; field: "highRisk" | "mediumRisk" | "lowRisk" | "unratedCount" }[] = [
  { key: "high", field: "highRisk" },
  { key: "medium", field: "mediumRisk" },
  { key: "low", field: "lowRisk" },
  { key: "unrated", field: "unratedCount" },
];

const RADIUS = 76;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const GAP = 3; // px of arc between segments — the "expressive" separated look

/**
 * Segment donut built on SVG strokes so every share change is a physical
 * morph (spring on dash array/offset) instead of a background repaint.
 * Legend and segments double as the table risk filter.
 */
export function RiskDonut({ summary, activeRisk, onSelectRisk }: RiskDonutProps) {
  const total = SEGMENTS.reduce((sum, seg) => sum + summary[seg.field], 0);
  const activeValue = activeRisk
    ? summary[SEGMENTS.find((seg) => seg.key === activeRisk)?.field ?? "highRisk"]
    : total;

  let cursor = 0;
  const arcs = SEGMENTS.map((seg) => {
    const value = summary[seg.field];
    const share = total ? value / total : 0;
    const start = cursor;
    cursor += share * CIRCUMFERENCE;
    const length = Math.max(share * CIRCUMFERENCE - (share > 0 ? GAP : 0), 0);
    return { ...seg, value, share, start, length };
  });

  return (
    <div className="risk-content">
      <div className="donut-wrap">
        <svg
          className="donut-svg"
          viewBox="0 0 180 180"
          role="img"
          aria-label={`Распределение риска: высокий ${integer(summary.highRisk)}, средний ${integer(summary.mediumRisk)}, низкий ${integer(summary.lowRisk)}, без оценки ${integer(summary.unratedCount)}`}
        >
          <circle className="donut-track" cx="90" cy="90" r={RADIUS} />
          <g className="donut-arcs">
            {arcs.map((arc) => {
              const dimmed = activeRisk !== "" && activeRisk !== arc.key;
              const selected = activeRisk === arc.key;
              return (
                <motion.circle
                  key={arc.key}
                  className={`donut-arc donut-arc-${arc.key}`}
                  cx="90"
                  cy="90"
                  r={RADIUS}
                  initial={false}
                  animate={{
                    strokeDasharray: `${arc.length} ${Math.max(CIRCUMFERENCE - arc.length, 0)}`,
                    strokeDashoffset: -arc.start,
                    strokeWidth: selected ? 27 : 21,
                    opacity: dimmed ? 0.28 : 1,
                  }}
                  transition={springEmphasized}
                />
              );
            })}
          </g>
        </svg>
        <div className="donut-center" aria-hidden="true">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.strong
              key={activeRisk || "all"}
              initial={{ opacity: 0, y: 10, scale: 0.92 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.92 }}
              transition={springSnappy}
            >
              {integer(activeValue)}
            </motion.strong>
          </AnimatePresence>
          <span>{activeRisk ? RISK_LABELS[activeRisk].toLowerCase() : "клиентов"}</span>
        </div>
      </div>

      <div className="risk-legend" role="group" aria-label="Фильтр по уровню риска из диаграммы">
        {arcs.map((arc) => {
          const selected = activeRisk === arc.key;
          return (
            <motion.button
              key={arc.key}
              type="button"
              className={`legend-row${selected ? " is-selected" : ""}`}
              aria-pressed={selected}
              onClick={() => onSelectRisk(selected ? "" : arc.key)}
              whileTap={{ scale: 0.98 }}
              transition={springSnappy}
            >
              <span className={`legend-key legend-key-${arc.key}`} aria-hidden="true" />
              <span className="legend-label">{RISK_LABELS[arc.key]}</span>
              <span className="legend-share">
                {total ? `${Math.round(arc.share * 100)}%` : "—"}
              </span>
              <strong>{integer(arc.value)}</strong>
              {selected && (
                <motion.span
                  className="legend-selected-bg"
                  layoutId="legend-selected"
                  transition={springSnappy}
                  aria-hidden="true"
                />
              )}
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}

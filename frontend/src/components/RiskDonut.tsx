import { motion } from "framer-motion";
import type { RiskLevel, Summary } from "../types";
import { RISK_LABELS } from "../types";
import { integer } from "../format";
import { springEmphasized, springFollow } from "../motion";
import { AnimatedNumber } from "./AnimatedNumber";
import { useDragSelect } from "./useDragSelect";

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
const SEGMENT_KEYS = SEGMENTS.map((seg) => seg.key);

const RADIUS = 76;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const GAP = 3; // px of arc between segments — the "expressive" separated look

/**
 * Segment donut built on SVG strokes so every share change is a physical
 * morph (spring on dash array/offset) instead of a background repaint.
 *
 * The centre number is a spring-tweened AnimatedNumber — it flows between
 * values with zero positional movement (the previous popLayout swap dipped
 * vertically on every switch). The legend is drag-select: hold and slide,
 * arcs preview the hovered segment live, release commits the filter.
 */
export function RiskDonut({ summary, activeRisk, onSelectRisk }: RiskDonutProps) {
  const drag = useDragSelect<RiskLevel>({
    values: SEGMENT_KEYS,
    selected: activeRisk === "" ? null : activeRisk,
    axis: "y",
    onCommit: (value, meta) => onSelectRisk(meta.tappedSelected ? "" : value),
  });

  const effectiveRisk: RiskLevel | "" = drag.active ?? "";
  const total = SEGMENTS.reduce((sum, seg) => sum + summary[seg.field], 0);
  const activeValue = effectiveRisk
    ? summary[SEGMENTS.find((seg) => seg.key === effectiveRisk)?.field ?? "highRisk"]
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
              const dimmed = effectiveRisk !== "" && effectiveRisk !== arc.key;
              const selected = effectiveRisk === arc.key;
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
          <AnimatedNumber
            value={activeValue}
            format={integer}
            className="donut-center-value"
          />
          <span>{effectiveRisk ? RISK_LABELS[effectiveRisk].toLowerCase() : "клиентов"}</span>
        </div>
      </div>

      <div
        className="risk-legend drag-select"
        role="group"
        aria-label="Фильтр по уровню риска из диаграммы. Можно зажать и вести указатель."
        ref={drag.containerRef}
        data-dragging={drag.dragging || undefined}
        {...drag.containerHandlers}
      >
        {drag.thumbRect && (
          <motion.span
            className="legend-selected-bg drag-thumb"
            aria-hidden="true"
            initial={false}
            animate={{
              x: drag.thumbRect.x,
              y: drag.thumbRect.y,
              width: drag.thumbRect.w,
              height: drag.thumbRect.h,
              opacity: drag.active ? 1 : 0,
            }}
            transition={springFollow}
          />
        )}
        {arcs.map((arc) => {
          const selected = effectiveRisk === arc.key;
          return (
            <button
              key={arc.key}
              ref={drag.registerItem(arc.key)}
              type="button"
              className={`legend-row${selected ? " is-selected" : ""}`}
              aria-pressed={activeRisk === arc.key}
              onClick={(event) => drag.handleItemClick(arc.key, event)}
            >
              <span className={`legend-key legend-key-${arc.key}`} aria-hidden="true" />
              <span className="legend-label">{RISK_LABELS[arc.key]}</span>
              <span className="legend-share">
                {total ? `${Math.round(arc.share * 100)}%` : "—"}
              </span>
              <strong>{integer(arc.value)}</strong>
            </button>
          );
        })}
      </div>
    </div>
  );
}

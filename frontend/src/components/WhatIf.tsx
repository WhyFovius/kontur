import { AnimatePresence, motion } from "framer-motion";
import type { RiskLevel } from "../types";
import { RISK_LABELS } from "../types";
import { integer, money } from "../format";
import { fadeRise, springEmphasized, springSnappy } from "../motion";
import { AnimatedNumber } from "./AnimatedNumber";
import type { LevelCounts, SimulationResult } from "../simulate";

interface WhatIfPanelProps {
  sim: SimulationResult;
  currentCounts: LevelCounts;
  currentLoss: number;
  customersLoaded: number;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onReset: () => void;
  onOpenCustomer: (id: string, level: RiskLevel) => void;
}

const LEVELS: Array<Exclude<RiskLevel, "unrated">> = ["high", "medium", "low"];

function DistBar({
  label,
  counts,
  compare,
}: {
  label: string;
  counts: LevelCounts;
  compare?: LevelCounts;
}) {
  const total = Math.max(1, counts.high + counts.medium + counts.low);
  return (
    <div className="dist-row">
      <span className="dist-label">{label}</span>
      <div
        className="dist-bar"
        role="img"
        aria-label={`${label}: высокий риск ${counts.high}, средний ${counts.medium}, низкий ${counts.low}`}
      >
        {LEVELS.map((level) => (
          <motion.span
            key={level}
            className={`dist-seg dist-seg-${level}`}
            initial={false}
            animate={{ width: `${(counts[level] / total) * 100}%` }}
            transition={springEmphasized}
          />
        ))}
      </div>
      <span className="dist-counts">
        {LEVELS.map((level) => {
          const delta = compare ? counts[level] - compare[level] : 0;
          return (
            <span key={level} className="dist-count">
              <span className={`risk-dot risk-dot-${level}`} aria-hidden="true" />
              {integer(counts[level])}
              {compare && delta !== 0 && (
                <strong className={delta > 0 ? "delta-bad" : "delta-good"}>
                  {delta > 0 ? `+${delta}` : `−${Math.abs(delta)}`}
                </strong>
              )}
            </span>
          );
        })}
      </span>
    </div>
  );
}

/**
 * Compact sticky scenario card that lives next to the weight sliders:
 * distribution now vs. scenario, revenue-at-risk delta and the biggest
 * movers — one glance, no scrolling, nothing is saved until "Применить".
 */
export function WhatIfPanel({
  sim,
  currentCounts,
  currentLoss,
  customersLoaded,
  dirty,
  saving,
  onSave,
  onReset,
  onOpenCustomer,
}: WhatIfPanelProps) {
  const lossDelta = sim.estimatedLoss - currentLoss;

  return (
    <motion.aside
      className="panel whatif-panel"
      variants={fadeRise}
      custom={0.08}
      initial="hidden"
      animate="show"
      aria-label="What-if сценарий весов"
    >
      <div className="panel-heading whatif-heading">
        <div>
          <span className="eyebrow">Сценарий · what-if</span>
          <h2>Эффект новых весов</h2>
        </div>
        <span className="panel-meta">по {integer(customersLoaded)} клиентам</span>
      </div>
      <p className="whatif-intro">
        Ползунки слева меняют только этот сценарий. Сервер применит веса и пересчитает всех
        клиентов лишь по кнопке «Применить».
      </p>

      <div className="dist-compare">
        <DistBar label="Сейчас" counts={currentCounts} />
        <DistBar label="Сценарий" counts={sim.counts} compare={currentCounts} />
      </div>

      <div className="whatif-lossbox">
        <span className="whatif-loss-label">Выручка под риском · 90 дней</span>
        <span className="whatif-loss-values">
          <span className="whatif-loss-now">{money(currentLoss)}</span>
          <span aria-hidden="true">→</span>
          <AnimatedNumber value={sim.estimatedLoss} format={money} className="whatif-loss-next" />
        </span>
        <span
          className={`whatif-delta-pill ${lossDelta > 0 ? "is-bad" : lossDelta < 0 ? "is-good" : ""}`}
          aria-live="polite"
        >
          {lossDelta === 0
            ? "без изменений"
            : `${lossDelta > 0 ? "+" : "−"}${money(Math.abs(lossDelta))} к текущим потерям`}
        </span>
      </div>

      <div className="whatif-movers">
        <h3>
          {sim.movers.length
            ? `Сменят уровень: ${integer(sim.movers.length)}`
            : "Никто не сменит уровень"}
        </h3>
        <AnimatePresence initial={false}>
          {sim.movers.slice(0, 5).map((mover) => (
            <motion.button
              key={mover.id}
              type="button"
              className="mover-row"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={springSnappy}
              onClick={() => onOpenCustomer(mover.id, mover.fromLevel)}
              aria-label={`Открыть клиента ${mover.email}: после применения перейдёт из уровня «${RISK_LABELS[mover.fromLevel]}» в «${RISK_LABELS[mover.toLevel]}»`}
            >
              <span className="mover-email">{mover.email}</span>
              <span className="mover-path">
                <span className={`risk-dot risk-dot-${mover.fromLevel}`} aria-hidden="true" />
                {RISK_LABELS[mover.fromLevel]} → {RISK_LABELS[mover.toLevel]}
                <span className={`risk-dot risk-dot-${mover.toLevel}`} aria-hidden="true" />
              </span>
              <span className="mover-loss">
                {mover.toLoss - mover.fromLoss === 0
                  ? money(mover.toLoss)
                  : `${mover.toLoss - mover.fromLoss > 0 ? "+" : "−"}${money(Math.abs(mover.toLoss - mover.fromLoss))}`}
              </span>
            </motion.button>
          ))}
        </AnimatePresence>
        {sim.movers.length > 5 && (
          <p className="panel-hint">…и ещё {integer(sim.movers.length - 5)} с меньшим эффектом.</p>
        )}
      </div>

      <div className="whatif-actions">
        <md-filled-button disabled={!dirty || saving} onClick={onSave}>
          {saving ? "Применяем…" : "Применить веса"}
        </md-filled-button>
        <md-text-button disabled={!dirty || saving} onClick={onReset}>
          Сбросить
        </md-text-button>
        <span className="whatif-note" aria-live="polite">
          {dirty ? "Сценарий не применён" : "Совпадает с сохранёнными"}
        </span>
      </div>
    </motion.aside>
  );
}

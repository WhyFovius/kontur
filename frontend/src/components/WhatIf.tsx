import { AnimatePresence, motion } from "framer-motion";
import type { RiskLevel } from "../types";
import { RISK_LABELS } from "../types";
import { integer, money } from "../format";
import { fadeRise, springSnappy } from "../motion";
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

function deltaLabel(delta: number): string {
  if (delta === 0) return "±0";
  return `${delta > 0 ? "+" : "−"}${integer(Math.abs(delta))}`;
}

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
    <motion.section
      className="panel whatif-panel"
      variants={fadeRise}
      custom={0.08}
      initial="hidden"
      animate="show"
      aria-label="What-if симулятор коэффициентов"
    >
      <div className="panel-heading">
        <div className="section-heading-copy">
          <span className="eyebrow">What-if · до сохранения</span>
          <h2>Что изменится при этих весах</h2>
          <p>
            Двигайте ползунки выше — пересчёт идёт мгновенно в браузере и ничего не сохраняет.
            Сервер применит веса только по кнопке ниже.
          </p>
        </div>
        <span className="panel-meta">Основано на {integer(customersLoaded)} загруженных клиентах</span>
      </div>

      <div className="whatif-deltas">
        {LEVELS.map((level) => {
          const delta = sim.counts[level] - currentCounts[level];
          return (
            <div key={level} className={`whatif-chip whatif-${level}`}>
              <span className={`risk-dot risk-dot-${level}`} aria-hidden="true" />
              <span className="whatif-chip-label">{RISK_LABELS[level]}</span>
              <span className="whatif-chip-values">
                {integer(currentCounts[level])} → {integer(sim.counts[level])}
              </span>
              <strong className={delta === 0 ? "" : delta > 0 ? "delta-bad" : "delta-good"}>
                {deltaLabel(delta)}
              </strong>
            </div>
          );
        })}
        <div className="whatif-chip whatif-loss">
          <span className="whatif-chip-label">Выручка под риском</span>
          <AnimatedNumber value={sim.estimatedLoss} format={money} className="whatif-loss-value" />
          <strong className={lossDelta === 0 ? "" : lossDelta > 0 ? "delta-bad" : "delta-good"}>
            {lossDelta === 0 ? "без изменений" : `${lossDelta > 0 ? "+" : "−"}${money(Math.abs(lossDelta))}`}
          </strong>
        </div>
      </div>

      <div className="whatif-movers">
        <h3>
          {sim.movers.length
            ? `Сменят уровень: ${integer(sim.movers.length)}`
            : "Никто не сменит уровень"}
        </h3>
        <AnimatePresence initial={false}>
          {sim.movers.slice(0, 6).map((mover) => (
            <motion.button
              key={mover.id}
              type="button"
              className="mover-row"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={springSnappy}
              onClick={() => onOpenCustomer(mover.id, mover.fromLevel)}
              aria-label={`Открыть клиента ${mover.email}: после сохранения перейдёт из уровня «${RISK_LABELS[mover.fromLevel]}» в «${RISK_LABELS[mover.toLevel]}»`}
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
        {sim.movers.length > 6 && (
          <p className="panel-hint">…и ещё {integer(sim.movers.length - 6)} клиентов с меньшим эффектом.</p>
        )}
      </div>

      <div className="whatif-actions">
        <motion.button
          type="button"
          className="button button-primary"
          disabled={!dirty || saving}
          onClick={onSave}
          whileTap={{ scale: 0.96 }}
          transition={springSnappy}
        >
          {saving ? "Сохраняем…" : "Применить веса"}
        </motion.button>
        <motion.button
          type="button"
          className="button button-ghost"
          disabled={!dirty || saving}
          onClick={onReset}
          whileTap={{ scale: 0.96 }}
          transition={springSnappy}
        >
          Вернуть сохранённые
        </motion.button>
        <span className="whatif-note" aria-live="polite">
          {dirty ? "Есть несохранённый сценарий" : "Сценарий совпадает с сохранёнными весами"}
        </span>
      </div>
    </motion.section>
  );
}

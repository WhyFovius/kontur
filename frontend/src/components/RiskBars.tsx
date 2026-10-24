import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Customer } from "../types";
import { RISK_LABELS } from "../types";
import { integer, money } from "../format";
import { fadeRise, springEmphasized, springSnappy } from "../motion";
import { AnimatedNumber } from "./AnimatedNumber";

interface RiskBarsProps {
  customers: Customer[];
  onOpen: (customer: Customer) => void;
}

const TOP_N = 10;

/**
 * Revenue-at-risk concentration, as clean animated 2D bars (the CSS-3D
 * landscape was retired — unreadable at small portfolio sizes). Pattern
 * borrowed from 21st.dev-style dashboards: gradient fills, spotlight
 * hover that follows the pointer, staggered spring growth. Clicking a
 * row opens the customer; hovering/focusing explains it in the inspector.
 */
export function RiskBars({ customers, onOpen }: RiskBarsProps) {
  const { shown, totalLoss, shownLoss, ratedCount } = useMemo(() => {
    const rated = customers.filter((customer) => customer.score != null);
    const sorted = [...rated].sort(
      (a, b) => b.estimatedLoss - a.estimatedLoss || (b.score ?? 0) - (a.score ?? 0),
    );
    const top = sorted.slice(0, TOP_N);
    return {
      shown: top,
      ratedCount: rated.length,
      totalLoss: sorted.reduce((sum, c) => sum + (Number(c.estimatedLoss) || 0), 0),
      shownLoss: top.reduce((sum, c) => sum + (Number(c.estimatedLoss) || 0), 0),
    };
  }, [customers]);

  const maxLoss = Math.max(0, ...shown.map((c) => c.estimatedLoss));
  const share = totalLoss > 0 ? Math.round((shownLoss / totalLoss) * 100) : 0;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = shown.find((c) => c.id === selectedId) ?? shown[0] ?? null;
  const selectedRank = selected ? shown.indexOf(selected) + 1 : 0;

  const expiryText = (customer: Customer): string =>
    customer.daysToExpiry == null
      ? "—"
      : customer.daysToExpiry < 0
        ? "срок прошёл"
        : `через ${integer(Math.round(customer.daysToExpiry))} дн.`;

  return (
    <motion.section
      className="panel riskbars-panel"
      variants={fadeRise}
      custom={0.14}
      initial="hidden"
      animate="show"
      aria-label="Выручка под риском по клиентам"
    >
      <div className="panel-heading">
        <div className="section-heading-copy">
          <span className="eyebrow">Концентрация риска</span>
          <h2>Выручка под риском по клиентам</h2>
          <p>
            Длина полосы — деньги под угрозой на 90 дней, цвет — уровень риска. Наведите,
            чтобы увидеть детали справа; клик по строке открывает клиента в очереди.
          </p>
        </div>
        <span className="panel-meta">
          Топ-{shown.length} = {share}% выручки под риском
        </span>
      </div>

      {shown.length === 0 ? (
        <div className="table-state">
          <strong>Пока некого показать</strong>
          <span>Оценённые клиенты появятся здесь после загрузки снимка с услугами.</span>
        </div>
      ) : (
        <div className="landscape-body">
          <div className="riskbars-list" role="list" aria-label="Клиенты по убыванию выручки под риском">
            {shown.map((customer, index) => {
              const isSelected = selected?.id === customer.id;
              const fill = maxLoss > 0 ? customer.estimatedLoss / maxLoss : 0;
              return (
                <motion.button
                  key={customer.id}
                  type="button"
                  role="listitem"
                  className={`riskbar-row riskbar-${customer.riskLevel}${isSelected ? " is-selected" : ""}`}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ ...springEmphasized, delay: 0.04 * index }}
                  onClick={() => onOpen(customer)}
                  onPointerEnter={(event) => {
                    if (event.pointerType === "mouse") setSelectedId(customer.id);
                  }}
                  onFocus={() => setSelectedId(customer.id)}
                  onPointerMove={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    event.currentTarget.style.setProperty(
                      "--mx",
                      `${event.clientX - rect.left}px`,
                    );
                    event.currentTarget.style.setProperty(
                      "--my",
                      `${event.clientY - rect.top}px`,
                    );
                  }}
                  aria-label={`Открыть клиента ${customer.email}: ${RISK_LABELS[customer.riskLevel]} риск, score ${customer.score ?? "—"}, под риском ${money(customer.estimatedLoss)}`}
                >
                  <span className="riskbar-rank" aria-hidden="true">
                    {index + 1}
                  </span>
                  <span className="riskbar-main">
                    <span className="riskbar-head">
                      <span className={`risk-dot risk-dot-${customer.riskLevel}`} aria-hidden="true" />
                      <span className="riskbar-email" title={customer.email}>
                        {customer.email}
                      </span>
                      <span className="riskbar-score">score {customer.score ?? "—"}</span>
                    </span>
                    <span className="riskbar-track" aria-hidden="true">
                      <motion.span
                        className="riskbar-fill"
                        initial={{ scaleX: 0 }}
                        animate={{ scaleX: fill }}
                        transition={{ ...springEmphasized, delay: 0.1 + 0.04 * index }}
                      />
                    </span>
                  </span>
                  <span className="riskbar-value">{money(customer.estimatedLoss)}</span>
                </motion.button>
              );
            })}
            <p className="panel-hint riskbars-note">
              Показаны топ-{shown.length} из {integer(ratedCount)} оценённых клиентов среди{" "}
              {integer(customers.length)} загруженных · полная очередь — на странице
              «Клиенты».
            </p>
          </div>

          <aside className="landscape-inspector" aria-live="polite">
            <AnimatePresence mode="wait" initial={false}>
              {selected ? (
                <motion.div
                  key={selected.id}
                  className="land-insp-body"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={springSnappy}
                >
                  <div className="land-insp-head">
                    <span className={`land-insp-pill land-insp-${selected.riskLevel}`}>
                      <span className={`risk-dot risk-dot-${selected.riskLevel}`} aria-hidden="true" />
                      {RISK_LABELS[selected.riskLevel]} риск
                    </span>
                    <span className="land-insp-rank">№{selectedRank} по деньгам под риском</span>
                  </div>
                  <strong className="land-insp-email" title={selected.email}>
                    {selected.email}
                  </strong>
                  <div className="land-insp-score">
                    <AnimatedNumber value={selected.score ?? 0} format={integer} />
                    <span>риск-скор из 100</span>
                  </div>
                  <div className="land-insp-stats">
                    <div>
                      <span>Под риском · 90 дней</span>
                      <strong>{money(selected.estimatedLoss)}</strong>
                    </div>
                    <div>
                      <span>Выручка в месяц</span>
                      <strong>{money(selected.monthlyRevenue)}</strong>
                    </div>
                    <div>
                      <span>Ближайшее окончание</span>
                      <strong>{expiryText(selected)}</strong>
                    </div>
                    <div>
                      <span>Баланс</span>
                      <strong>{money(selected.balance)}</strong>
                    </div>
                  </div>
                  {selected.reasons?.[0] && (
                    <p className="land-insp-reason">{selected.reasons[0]}</p>
                  )}
                  <md-filled-button class="land-insp-open" onClick={() => onOpen(selected)}>
                    Открыть в очереди
                  </md-filled-button>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </aside>
        </div>
      )}
    </motion.section>
  );
}

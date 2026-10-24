import { motion } from "framer-motion";
import type { Summary } from "../types";
import { integer, money } from "../format";
import { springEmphasized, springSnappy, staggerChild } from "../motion";
import { AnimatedNumber } from "./AnimatedNumber";
import { IconArrowUpRight, IconCalendar, IconShield, IconUsers, IconWallet } from "../icons";

interface KpiCardsProps {
  summary: Summary;
  onShowHighRisk: () => void;
}

/**
 * Bento KPI row. Revenue-at-risk is the commercial hero: deep-green
 * expressive surface, spring-counted money, direct CTA into the filtered
 * work queue. Secondary cards stay quiet so the money reads first.
 */
export function KpiCards({ summary, onShowHighRisk }: KpiCardsProps) {
  const ratedPercent = summary.customerCount
    ? Math.round((summary.ratedCount / summary.customerCount) * 100)
    : 0;

  return (
    <motion.section
      className="metric-grid"
      aria-label="Ключевые показатели"
      variants={{ hidden: {}, show: { transition: { staggerChildren: 0.07 } } }}
      initial="hidden"
      animate="show"
    >
      <motion.article
        className="metric-card metric-hero"
        variants={staggerChild}
        whileHover={{ y: -3 }}
        transition={springSnappy}
      >
        <div className="metric-hero-glow" aria-hidden="true" />
        <div className="metric-top">
          <span>Выручка под риском</span>
          <span className="metric-symbol metric-symbol-hero" aria-hidden="true">
            <IconWallet />
          </span>
        </div>
        <AnimatedNumber
          value={summary.estimatedLoss}
          format={money}
          className="metric-value metric-value-hero"
          label={money(summary.estimatedLoss)}
        />
        <p className="metric-hero-sub">
          В среднем{" "}
          <AnimatedNumber value={summary.monthlyRevenueAtRisk} format={money} /> в месяц ·
          сценарная оценка на 90 дней, ориентир для приоритета контакта
        </p>
        <motion.button
          type="button"
          className="metric-hero-cta"
          onClick={onShowHighRisk}
          whileTap={{ scale: 0.96 }}
          whileHover={{ scale: 1.02 }}
          transition={springSnappy}
        >
          Смотреть высокий риск <IconArrowUpRight />
        </motion.button>
        <div className="metric-hero-bars" aria-hidden="true">
          {[0.45, 0.7, 0.55, 0.9, 0.65, 1].map((height, index) => (
            <motion.span
              key={index}
              initial={{ scaleY: 0 }}
              animate={{ scaleY: height }}
              transition={{ ...springEmphasized, delay: 0.25 + index * 0.06 }}
            />
          ))}
        </div>
      </motion.article>

      <motion.article
        className="metric-card metric-card-high"
        variants={staggerChild}
        whileHover={{ y: -3 }}
        transition={springSnappy}
      >
        <div className="metric-top">
          <span>Высокий риск</span>
          <span className="metric-symbol metric-symbol-risk" aria-hidden="true">
            <IconShield />
          </span>
        </div>
        <AnimatedNumber
          value={summary.highRisk}
          format={integer}
          className="metric-value"
        />
        <div className="metric-caption">
          <span className="risk-dot risk-dot-high" aria-hidden="true" />
          Нужен контакт команды
        </div>
        <button type="button" className="metric-link" onClick={onShowHighRisk}>
          Открыть очередь <IconArrowUpRight />
        </button>
      </motion.article>

      <motion.article
        className="metric-card"
        variants={staggerChild}
        whileHover={{ y: -3 }}
        transition={springSnappy}
      >
        <div className="metric-top">
          <span>Клиентов в анализе</span>
          <span className="metric-symbol" aria-hidden="true">
            <IconUsers />
          </span>
        </div>
        <AnimatedNumber
          value={summary.customerCount}
          format={integer}
          className="metric-value"
        />
        <div className="metric-caption">
          {integer(summary.ratedCount)} оценено · {ratedPercent}% от списка
        </div>
        <span className="rated-track" aria-hidden="true">
          <motion.span
            initial={false}
            animate={{ scaleX: ratedPercent / 100 }}
            transition={springEmphasized}
          />
        </span>
      </motion.article>

      <motion.article
        className="metric-card"
        variants={staggerChild}
        whileHover={{ y: -3 }}
        transition={springSnappy}
      >
        <div className="metric-top">
          <span>Услуги под риском</span>
          <span className="metric-symbol" aria-hidden="true">
            <IconCalendar />
          </span>
        </div>
        <AnimatedNumber
          value={summary.atRiskServices}
          format={integer}
          className="metric-value"
        />
        <div className="metric-caption">
          Скорое окончание или ожидание оплаты
        </div>
      </motion.article>
    </motion.section>
  );
}

export function KpiSkeletons() {
  return (
    <section className="metric-grid" aria-label="Загружаем показатели">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="metric-card metric-skeleton-card" aria-hidden="true">
          <span className="skeleton skeleton-line skeleton-line-narrow" />
          <span className="skeleton skeleton-line skeleton-line-hero" />
          <span className="skeleton skeleton-line" />
        </div>
      ))}
      <span className="sr-only">Загружаем показатели…</span>
    </section>
  );
}

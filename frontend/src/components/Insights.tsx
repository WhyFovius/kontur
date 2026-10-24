import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import type { Customer, Summary } from "../types";
import { integer, money } from "../format";
import { emphasizedTween, fadeRise, springSnappy } from "../motion";
import { AnimatedNumber } from "./AnimatedNumber";

/* ---------------- Saved-revenue calculator ---------------- */

export function RevenueCalculator({
  lossHigh,
  lossMedium,
}: {
  lossHigh: number;
  lossMedium: number;
}) {
  const [highRate, setHighRate] = useState(30);
  const [mediumRate, setMediumRate] = useState(50);
  const saved = Math.round((lossHigh * highRate) / 100 + (lossMedium * mediumRate) / 100);

  const sliderRow = (
    label: string,
    loss: number,
    rate: number,
    setRate: (value: number) => void,
  ) => (
    <div className="calc-row">
      <div className="calc-row-head">
        <label htmlFor={`calc-${label}`}>{label}</label>
        <span className="calc-row-meta">
          {money(loss)} под риском · <strong>{rate}%</strong>
        </span>
      </div>
      <md-slider
        id={`calc-${label}`}
        class="calc-md-slider"
        min={0}
        max={100}
        step={5}
        value={rate}
        labeled
        aria-label={label}
        onInput={(event: React.SyntheticEvent<HTMLElement>) =>
          setRate(Number((event.target as unknown as { value: number }).value))
        }
      />
    </div>
  );

  return (
    <motion.section
      className="panel insight-panel"
      variants={fadeRise}
      custom={0.08}
      initial="hidden"
      animate="show"
      aria-label="Калькулятор спасённой выручки"
    >
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Сценарий удержания</span>
          <h2>Сколько выручки спасёт команда</h2>
        </div>
      </div>
      {sliderRow("Удастся удержать из высокого риска", lossHigh, highRate, setHighRate)}
      {sliderRow("Удастся удержать из среднего риска", lossMedium, mediumRate, setMediumRate)}
      <div className="calc-result">
        <span>Спасённая выручка по сценарию</span>
        <AnimatedNumber value={saved} format={money} className="calc-result-value" />
        <span className="calc-result-sub">≈ {money(Math.round(saved / 3))} в месяц на горизонте 90 дней</span>
      </div>
      <p className="panel-hint">
        Сценарий поверх текущей оценки потерь — инструмент для целеполагания команды, а не
        финансовый прогноз.
      </p>
    </motion.section>
  );
}

/* ---------------- Data quality centre ---------------- */

export function DataQuality({
  summary,
  customers,
  onShowUnrated,
}: {
  summary: Summary;
  customers: Customer[];
  onShowUnrated: () => void;
}) {
  const stats = useMemo(() => {
    const loaded = customers.length;
    const ratedLoaded = customers.filter((customer) => customer.score != null);
    const noServices = customers.filter((customer) => !customer.services?.length).length;
    const missingExpiry = ratedLoaded.filter(
      (customer) => customer.daysToExpiry == null,
    ).length;
    const failed = customers.filter(
      (customer) => customer.features?.failed_transactions,
    ).length;
    const ratedShare = summary.customerCount
      ? summary.ratedCount / summary.customerCount
      : 0;
    const noServicesShare = loaded ? noServices / loaded : 0;
    const missingExpiryShare = ratedLoaded.length ? missingExpiry / ratedLoaded.length : 0;
    const score = Math.round(
      100 * (ratedShare * 0.55 + (1 - noServicesShare) * 0.2 + (1 - missingExpiryShare) * 0.25),
    );
    return { loaded, ratedShare, noServices, noServicesShare, missingExpiry, missingExpiryShare, failed, score };
  }, [customers, summary]);

  const radius = 30;
  const circumference = 2 * Math.PI * radius;
  const filled = (stats.score / 100) * circumference;
  const tone = stats.score >= 85 ? "low" : stats.score >= 60 ? "medium" : "high";

  const row = (label: string, value: string, good: boolean) => (
    <li className="quality-row">
      <span className={`risk-dot risk-dot-${good ? "low" : "medium"}`} aria-hidden="true" />
      <span className="quality-label">{label}</span>
      <strong>{value}</strong>
    </li>
  );

  return (
    <motion.section
      className="panel insight-panel"
      variants={fadeRise}
      custom={0.14}
      initial="hidden"
      animate="show"
      aria-label="Центр качества данных"
    >
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Качество данных</span>
          <h2>Насколько можно доверять оценке</h2>
        </div>
      </div>
      <div className="quality-head">
        <div className={`quality-ring quality-ring-${tone}`} role="img" aria-label={`Индекс качества данных ${stats.score} из 100`}>
          <svg viewBox="0 0 76 76" aria-hidden="true">
            <circle className="quality-ring-track" cx="38" cy="38" r={radius} />
            <motion.circle
              className="quality-ring-fill"
              cx="38"
              cy="38"
              r={radius}
              initial={false}
              animate={{ strokeDasharray: `${filled} ${circumference - filled}` }}
              transition={emphasizedTween}
            />
          </svg>
          <span aria-hidden="true">
            <AnimatedNumber value={stats.score} format={integer} />
          </span>
        </div>
        <p>
          Оценено {integer(summary.ratedCount)} из {integer(summary.customerCount)} клиентов
          ({Math.round(stats.ratedShare * 100)}%). Честная картина пробелов важнее красивой
          средней цифры.
        </p>
      </div>
      <ul className="quality-list">
        {row("Клиентов без оценки", integer(summary.unratedCount), summary.unratedCount === 0)}
        {row("Без услуг в снимке", integer(stats.noServices), stats.noServicesShare < 0.15)}
        {row(
          "Без даты окончания услуг",
          integer(stats.missingExpiry),
          stats.missingExpiryShare < 0.25,
        )}
        {row("С незавершёнными платежами", integer(stats.failed), stats.failed === 0)}
      </ul>
      {stats.loaded < summary.customerCount && (
        <p className="panel-hint">
          Детализация посчитана по первым {integer(stats.loaded)} клиентам из{" "}
          {integer(summary.customerCount)}.
        </p>
      )}
      {summary.unratedCount > 0 && (
        <md-filled-tonal-button class="quality-action" onClick={onShowUnrated}>
          Показать клиентов без оценки · {integer(summary.unratedCount)}
        </md-filled-tonal-button>
      )}
    </motion.section>
  );
}

/* ---------------- Portfolio history (browser-local) ---------------- */

export interface HistoryPoint {
  t: number;
  loss: number;
  high: number;
}

export function ScoreHistory({ points }: { points: HistoryPoint[] }) {
  const sorted = useMemo(() => [...points].sort((a, b) => a.t - b.t), [points]);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const delta = first && last ? last.loss - first.loss : 0;

  const path = useMemo(() => {
    if (sorted.length < 2) return { line: "", area: "" };
    const width = 280;
    const height = 92;
    const pad = 8;
    const losses = sorted.map((point) => point.loss);
    const min = Math.min(...losses);
    const max = Math.max(...losses);
    const span = Math.max(max - min, 1);
    const coords = sorted.map((point, index) => {
      const x = pad + (index / (sorted.length - 1)) * (width - pad * 2);
      const y = height - pad - ((point.loss - min) / span) * (height - pad * 2 - 8) - 4;
      return [Math.round(x * 10) / 10, Math.round(y * 10) / 10] as const;
    });
    const line = coords.map(([x, y], index) => `${index ? "L" : "M"} ${x} ${y}`).join(" ");
    const area = `${line} L ${coords[coords.length - 1][0]} ${height} L ${coords[0][0]} ${height} Z`;
    return { line, area };
  }, [sorted]);

  return (
    <motion.section
      className="panel insight-panel"
      variants={fadeRise}
      custom={0.2}
      initial="hidden"
      animate="show"
      aria-label="История выручки под риском"
    >
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Динамика</span>
          <h2>История риска портфеля</h2>
        </div>
        {last && (
          <span className={`history-delta ${delta > 0 ? "is-up" : delta < 0 ? "is-down" : ""}`}>
            {delta === 0 ? "без изменений" : `${delta > 0 ? "▲" : "▼"} ${money(Math.abs(delta))}`}
          </span>
        )}
      </div>

      {sorted.length < 2 ? (
        <div className="history-empty">
          <strong>
            {last ? money(last.loss) : "—"}
          </strong>
          <span>
            Первая точка записана. График появится, когда снимок или веса изменят оценку —
            история копится локально в этом браузере при каждом значимом обновлении.
          </span>
        </div>
      ) : (
        <>
          <svg
            className="history-chart"
            viewBox="0 0 280 92"
            role="img"
            aria-label={`Выручка под риском изменилась с ${money(first.loss)} до ${money(last.loss)} за ${sorted.length} точек наблюдения.`}
            preserveAspectRatio="none"
          >
            <defs>
              <linearGradient id="historyGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" className="chart-gradient-start" />
                <stop offset="100%" className="chart-gradient-end" />
              </linearGradient>
            </defs>
            <motion.path className="history-area" initial={false} animate={{ d: path.area }} transition={emphasizedTween} />
            <motion.path className="history-line" initial={false} animate={{ d: path.line }} transition={emphasizedTween} />
          </svg>
          <div className="history-range" aria-hidden="true">
            <span>{new Date(first.t).toLocaleDateString("ru-RU")}</span>
            <span>{money(last.loss)} сейчас</span>
            <span>{new Date(last.t).toLocaleDateString("ru-RU")}</span>
          </div>
        </>
      )}
      <p className="panel-hint">
        Локальная история этого браузера. Для командной истории по каждому клиенту нужен
        серверный журнал снимков — он в дорожной карте бэкенда.
      </p>
    </motion.section>
  );
}

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import type { Customer, Summary } from "../types";
import { integer, money } from "../format";
import { emphasizedTween, fadeRise, springEmphasized, springSnappy } from "../motion";
import { AnimatedNumber } from "./AnimatedNumber";
import { ExpressiveSlider } from "./ExpressiveSlider";

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
    id: string,
    label: string,
    loss: number,
    rate: number,
    setRate: (value: number) => void,
  ) => (
    <div className="calc-row">
      <div className="calc-row-head">
        <label htmlFor={id}>{label}</label>
        <span className="calc-row-meta">
          {money(loss)} под риском · <strong>{rate}%</strong>
        </span>
      </div>
      <ExpressiveSlider
        id={id}
        min={0}
        max={100}
        step={5}
        value={rate}
        label={label}
        formatValue={(next) => `${next}%`}
        onChange={setRate}
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
      {sliderRow("calc-high", "Удастся удержать из высокого риска", lossHigh, highRate, setHighRate)}
      {sliderRow("calc-medium", "Удастся удержать из среднего риска", lossMedium, mediumRate, setMediumRate)}
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

  const tone = stats.score >= 85 ? "low" : stats.score >= 60 ? "medium" : "high";

  /* Semicircle tick gauge: 41 ticks light up in a cascade up to the score. */
  const [lit, setLit] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setLit(true), 120);
    return () => window.clearTimeout(id);
  }, []);
  const ticks = useMemo(() => {
    const n = 41;
    const cx = 80;
    const cy = 86;
    return Array.from({ length: n }, (_, i) => {
      const f = i / (n - 1);
      const a = Math.PI * (1 - f);
      const rOuter = 76;
      const rInner = i % 5 === 0 ? 60 : 65;
      return {
        i,
        x1: cx + rInner * Math.cos(a),
        y1: cy - rInner * Math.sin(a),
        x2: cx + rOuter * Math.cos(a),
        y2: cy - rOuter * Math.sin(a),
        on: lit && f <= stats.score / 100,
      };
    });
  }, [lit, stats.score]);

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
        <div
          className={`quality-gauge quality-gauge-${tone}`}
          role="img"
          aria-label={`Индекс качества данных ${stats.score} из 100`}
        >
          <svg viewBox="0 0 160 94" aria-hidden="true">
            {ticks.map((t) => (
              <line
                key={t.i}
                x1={t.x1}
                y1={t.y1}
                x2={t.x2}
                y2={t.y2}
                className={`gauge-tick${t.on ? " is-on" : ""}`}
                style={{ transitionDelay: `${t.i * 14}ms` }}
              />
            ))}
          </svg>
          <span className="quality-gauge-value" aria-hidden="true">
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

  /* One bar per observation-to-observation change (Web3-bento PnL-strip
     pattern): red up = more revenue at risk, green down = less. */
  const changes = useMemo(
    () =>
      sorted.slice(1).map((point, i) => ({
        t: point.t,
        change: point.loss - sorted[i].loss,
        loss: point.loss,
      })),
    [sorted],
  );
  const maxAbs = Math.max(1, ...changes.map((c) => Math.abs(c.change)));
  const [hover, setHover] = useState<number | null>(null);
  const dayLabel = (t: number) =>
    new Date(t).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
  const changeText = (change: number) =>
    change === 0
      ? "без изменений"
      : `${change > 0 ? "+" : "−"}${money(Math.abs(change))}`;

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

      {changes.length === 0 ? (
        <div className="history-empty">
          <strong>{last ? money(last.loss) : "—"}</strong>
          <span>
            Первая точка записана. Полоса изменений появится, когда снимок или веса изменят
            оценку, — история копится локально в этом браузере при каждом значимом
            обновлении.
          </span>
        </div>
      ) : (
        <>
          <div
            className="history-bars"
            role="group"
            aria-label={`Изменения выручки под риском между наблюдениями: с ${money(first.loss)} до ${money(last.loss)}.`}
            onPointerLeave={() => setHover(null)}
          >
            {changes.map((c, i) => {
              const h = 14 + (Math.abs(c.change) / maxAbs) * 86;
              const cls = c.change > 0 ? "is-up" : c.change < 0 ? "is-down" : "is-flat";
              return (
                <motion.button
                  key={`${c.t}-${i}`}
                  type="button"
                  className={`history-bar ${cls}`}
                  initial={{ height: "8%" }}
                  animate={{ height: `${h}%` }}
                  transition={{ ...springEmphasized, delay: i * 0.02 }}
                  style={{
                    opacity:
                      hover === null
                        ? 0.45 + (Math.abs(c.change) / maxAbs) * 0.55
                        : hover === i
                          ? 1
                          : 0.25,
                  }}
                  onPointerEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  aria-label={`${dayLabel(c.t)}: ${changeText(c.change)}, стало ${money(c.loss)}`}
                />
              );
            })}
          </div>
          <div className="history-bars-meta">
            <span>{dayLabel(first.t)}</span>
            <span className="history-readout" aria-live="polite">
              {hover !== null
                ? `${dayLabel(changes[hover].t)} · ${changeText(changes[hover].change)} → ${money(changes[hover].loss)}`
                : "Изменение между наблюдениями"}
            </span>
            <span>сейчас · {money(last.loss)}</span>
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
